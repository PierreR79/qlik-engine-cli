#!/usr/bin/env node
// qe — liten CLI mot Qlik Clouds Engine API (QIX) och REST via @qlik/api.
// Täcker det Qlik MCP inte kan: ändra/ta bort objekt, lägga till valfria objekt
// (knappar, text & bild), byta namn på appar, sätta skript och ladda om.
//
// Autentiseringen ligger i auth.mjs: maskinklient (OAuth) först, API-nyckel som
// reserv, båda ur macOS Keychain — aldrig från fil eller miljövariabel.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apps, auth, items, qix, reloads, users } from "@qlik/api";
import { hostConfig, tenantHost } from "./auth.mjs";

// @qlik/api känner av localStorage, som Node varnar för utan --localstorage-file. Ofarligt i en CLI.
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w).includes("localStorage") ? undefined : emitWarning.call(process, w, ...rest));

const here = dirname(fileURLToPath(import.meta.url));
const host = tenantHost();

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const out = (x) => console.log(typeof x === "string" ? x : JSON.stringify(x, null, 2));

// Varje skrivning sparar objektets tidigare tillstånd först, så att den kan backas.
function backup(appId, name, data) {
  const dir = join(here, "backups", appId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
  console.error(`backup: ${file}`);
}

// Egen identity per körning. Utan den hamnar anropet i den DELADE
// app-instansen, som kan vara inaktuell: `qe sheets` listade tre ark och
// `qe get` svarade "Object not found" på objekt som just hade skapats via MCP,
// medan verktygen i tools/ såg dem direkt — de har alltid skickat en identity.
//
// Varning som följer med, och som fanns även före den här ändringen: två
// sessioner mot samma app är två kopior av dokumentet, och sista doSave()
// vinner. Kör inte `qe set` mot en app någon annan redigerar samtidigt.
async function withDoc(appId, fn) {
  const session = qix.openAppSession({ appId, identity: `qe-${process.pid}-${Date.now()}` });
  try {
    return await fn(await session.getDoc());
  } finally {
    await session.close();
  }
}

const commands = {
  async whoami() {
    const { data } = await users.getMyUser();
    out({ host, name: data.name, email: data.email, roles: data.assignedRoles?.map((r) => r.name) });
  },

  async apps() {
    const { data } = await items.getItems({ resourceType: "app", limit: 100 });
    out(data.data.map((i) => ({ appId: i.resourceId, name: i.name, space: i.spaceId ?? "personal" })));
  },

  // Ark med sina objekt (id, typ, titel) — hitta objekt-id:n att ändra.
  async sheets(appId) {
    await withDoc(appId, async (doc) => {
      const list = await doc.getSheetList();
      const result = [];
      for (const s of list) {
        const sheet = await doc.getObject(s.qInfo.qId);
        const { qChildren = [] } = await sheet.getFullPropertyTree();
        result.push({
          sheetId: s.qInfo.qId,
          title: s.qData.title,
          objects: qChildren.map((c) => ({
            id: c.qProperty.qInfo.qId,
            type: c.qProperty.qInfo.qType,
            title: c.qProperty.title?.qStringExpression?.qExpr ?? c.qProperty.title ?? "",
          })),
        });
      }
      out(result);
    });
  },

  // Hela egenskapsträdet för ett objekt (ark, diagram, knapp …) som JSON.
  async get(appId, objectId) {
    await withDoc(appId, async (doc) => out(await (await doc.getObject(objectId)).getFullPropertyTree()));
  },

  // Skriv tillbaka ett (redigerat) egenskapsträd från fil.
  async set(appId, objectId, file) {
    const tree = JSON.parse(readFileSync(file, "utf8"));
    await withDoc(appId, async (doc) => {
      const obj = await doc.getObject(objectId);
      backup(appId, objectId, await obj.getFullPropertyTree());
      await obj.setFullPropertyTree(tree);
      await doc.doSave();
      out(`uppdaterat: ${objectId}`);
    });
  },

  // Nytt objekt på ett ark. Filen innehåller qProperty för objektet (t.ex. en knapp);
  // cellen läggs sist på arket med angiven placering (col,row,colspan,rowspan).
  async add(appId, sheetId, file, bounds = "0,0,6,2") {
    const props = JSON.parse(readFileSync(file, "utf8"));
    const [col, row, colspan, rowspan] = bounds.split(",").map(Number);
    await withDoc(appId, async (doc) => {
      const sheet = await doc.getObject(sheetId);
      const sheetProps = await sheet.getProperties();
      backup(appId, sheetId, await sheet.getFullPropertyTree());
      const child = await sheet.createChild(props);
      const { qInfo } = await child.getProperties();
      sheetProps.cells = [...(sheetProps.cells ?? []), { name: qInfo.qId, type: qInfo.qType, col, row, colspan, rowspan }];
      await sheet.setProperties(sheetProps);
      await doc.doSave();
      out({ created: qInfo.qId, type: qInfo.qType, sheetId });
    });
  },

  // Ta bort ett objekt. Ligger det på ett ark tas även dess cell bort.
  async rm(appId, objectId) {
    await withDoc(appId, async (doc) => {
      const obj = await doc.getObject(objectId);
      backup(appId, objectId, await obj.getFullPropertyTree());
      const parent = await obj.getParent().catch(() => null);
      if (parent) {
        const p = await parent.getProperties();
        if (Array.isArray(p.cells)) p.cells = p.cells.filter((c) => c.name !== objectId);
        await parent.destroyChild(objectId, p);
      } else {
        await doc.destroyObject(objectId);
      }
      await doc.doSave();
      out(`borttaget: ${objectId}`);
    });
  },

  async eval(appId, expression) {
    await withDoc(appId, async (doc) => out(await doc.evaluateEx(expression)));
  },

  async "script-get"(appId) {
    await withDoc(appId, async (doc) => out(await doc.getScript()));
  },

  // Sätt laddskriptet från fil (t.ex. qlik/*.qvs i ditt projekt). Laddar inte om.
  async "script-set"(appId, file) {
    const script = readFileSync(file, "utf8");
    await withDoc(appId, async (doc) => {
      backup(appId, "script", await doc.getScript());
      await doc.setScript(script);
      await doc.doSave();
      out(`skript satt (${script.length} tecken) — kör "reload" för att ladda`);
    });
  },

  // Omladdning via REST-kön (inte doReload över websocket) — överlever långa laddningar.
  async reload(appId) {
    const { data } = await reloads.queueReload({ appId });
    console.error(`reload ${data.id} köad`);
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      // noCache: @qlik/api cachar GET-svar, och utan det står statusen still på RELOADING.
      const { data: r } = await reloads.getReload(data.id, { noCache: true });
      if (!["QUEUED", "RELOADING", "CANCELING"].includes(r.status)) {
        out({ id: r.id, status: r.status, duration: r.duration });
        if (r.status !== "SUCCEEDED") fail(r.log?.slice(-2000) ?? "omladdningen misslyckades");
        return;
      }
    }
  },

  async rename(appId, name) {
    const { data } = await apps.updateAppInfo(appId, { attributes: { name } });
    out({ appId, name: data.attributes.name });
  },
};

const [cmd, ...args] = process.argv.slice(2);
if (!commands[cmd]) {
  fail(`användning: qe <kommando> [argument]\nkommandon: ${Object.keys(commands).join(", ")}`);
}

auth.setDefaultHostConfig(await hostConfig(host));
try {
  await commands[cmd](...args);
  // Vänta tills stdout är tömd — annars klipper exit() piped output vid 64 KB.
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(0);
} catch (e) {
  fail(e?.message ?? String(e));
}
