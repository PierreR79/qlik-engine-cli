// Allt i en app som en flytt eller skriptändring inte får röra: ark med
// objekt, bokmärken, variabler, stories, master items och appens identitet.
// Kompletterar snapshot.mjs (data och måttvärden).
//
// ## Varför en riktig hash, och varför kanonisering
//
// Fältet `hash` var tidigare `JSON.stringify(tree).length` — en LÄNGD, med
// kommentaren att den "fångar varje ändring". Den gjorde inte det. Varje
// ändring som bevarar längden var osynlig: `asc` → `des`, en siffra i ett
// uttryck, ett fältnamn utbytt mot ett annat lika långt. En vakt som missar en
// hel klass av det den ska upptäcka är sämre än ingen vakt, för den intygar.
//
// Längden gav också falska larm. Direkt efter att en baseline accepterats
// rapporterades alla fyra ark som ändrade, med +9 tecken var. Vad som växte gick
// inte att ta reda på — en längd säger att något ändrats, aldrig vad.
//
// Därför: sha256 över ett KANONISERAT träd (sorterade nycklar, volatila fält
// borttagna), plus en hash per objekt så att en skillnad går att peka ut. Det
// Qlik själv ändrar utan att någon bett om det — visualiseringarnas
// `version`, `creationDate`, arkets `rank` — ligger utanför hashen och
// rapporteras för sig, så att en versionsbump inte ser ut som en redigering.
import { createHash } from "node:crypto";
import { apps, auth, qix } from "@qlik/api";
import { hostConfig, tenantHost } from "../auth.mjs";

// Fält Qlik sätter eller ändrar själv. De ingår inte i hashen; de som är
// intressanta rapporteras som egna nycklar.
const VOLATILA = new Set([
  "creationDate", "modifiedDate", "createdDate", "lastReloadTime",
  "version",        // visualiseringens version — Qlik bumpar den åt dig
  "rank",           // arkets ordning; rapporteras separat som `rank`
  "owner", "ownerId", "qThumbnail", "thumbnail",
]);

/** Sorterade nycklar och volatila fält borta — samma innehåll ger samma sträng. */
function kanonisk(o) {
  if (Array.isArray(o)) return o.map(kanonisk);
  if (o && typeof o === "object") {
    const ut = {};
    for (const k of Object.keys(o).sort()) {
      if (VOLATILA.has(k)) continue;
      ut[k] = kanonisk(o[k]);
    }
    return ut;
  }
  return o;
}

const hasha = (o) => createHash("sha256").update(JSON.stringify(kanonisk(o))).digest("hex").slice(0, 16);

/** Visualiseringsversioner, utanför hashen men värda att se. */
function vizVersioner(tree) {
  const ut = {};
  for (const c of tree.qChildren ?? []) {
    const p = c.qProperty ?? {};
    if (p.version) ut[`${p.qInfo?.qType}:${p.qInfo?.qId}`] = p.version;
  }
  return ut;
}

process.emitWarning = () => {};
const host = tenantHost();
auth.setDefaultHostConfig(await hostConfig(host));

const appId = process.argv[2];
const { data: info } = await apps.getAppInfo(appId);
const session = qix.openAppSession({ appId, identity: "integrity" });
const doc = await session.getDoc();

async function list(qType, extra = {}) {
  const obj = await doc.createSessionObject({ qInfo: { qType: `${qType}-list` }, qAppObjectListDef: { qType, qData: { title: "/qMetaDef/title", ...extra } } });
  return (await obj.getLayout()).qAppObjectList.qItems;
}

const sheets = [];
for (const s of await list("sheet")) {
  const tree = await (await doc.getObject(s.qInfo.qId)).getFullPropertyTree();
  sheets.push({
    id: s.qInfo.qId,
    title: s.qMeta.title ?? s.qData.title,
    published: !!s.qMeta.published,
    approved: !!s.qMeta.approved,
    owner: s.qMeta.owner?.name,
    rank: tree.qProperty?.rank ?? null,
    objects: (tree.qChildren ?? []).map((c) => `${c.qProperty.qInfo.qType}:${c.qProperty.qInfo.qId}`).sort(),
    // Hela arket, kanoniserat. Ändras den här har något i arket ändrats.
    hash: hasha(tree),
    // En hash per objekt, så att en skillnad går att peka ut i stället för att
    // bara konstateras. Det är hela skillnaden mellan "något ändrades" och
    // "stapeldiagrammet Marginal per varumärke ändrades".
    objectHashes: Object.fromEntries(
      (tree.qChildren ?? []).map((c) => [`${c.qProperty.qInfo.qType}:${c.qProperty.qInfo.qId}`, hasha(c)]),
    ),
    vizVersions: vizVersioner(tree),
    // Informativ, aldrig ett villkor. Fanns som `hash` förr.
    size: JSON.stringify(tree).length,
  });
}
const byTitle = (a, b) => (a.title ?? "").localeCompare(b.title ?? "");
const ids = async (t) => (await list(t)).map((x) => `${x.qData.title ?? x.qMeta?.title}:${x.qInfo.qId}`).sort();

// Master items är inte AppObjectList-objekt; de har egna listtyper.
async function library(kind) {
  const T = kind === "measure" ? "Measure" : "Dimension";
  const obj = await doc.createSessionObject({ qInfo: { qType: `${kind}-lib` }, [`q${T}ListDef`]: { qType: kind, qData: { title: "/qMetaDef/title" } } });
  return (await obj.getLayout())[`q${T}List`].qItems.map((x) => `${x.qData.title}:${x.qInfo.qId}`).sort();
}

const variables = await doc.createSessionObject({ qInfo: { qType: "VariableList" }, qVariableListDef: { qType: "variable", qShowReserved: false, qShowConfig: false } });

console.log(JSON.stringify({
  appId: info.attributes.id,
  name: info.attributes.name,
  owner: info.attributes.owner,
  sheets: sheets.sort(byTitle),
  bookmarks: await ids("bookmark"),
  stories: await ids("story"),
  measures: await library("measure"),
  dimensions: await library("dimension"),
  variables: (await variables.getLayout()).qVariableList.qItems.map((v) => `${v.qName}=${v.qDefinition}`).sort(),
  // Skriptet hashas av samma skäl som arken: en ändring som bevarar längden var
  // osynlig förut, och qlik_sync skriver skriptet vid varje jobbkörning.
  scriptHash: hasha(await doc.getScript()),
  scriptLength: (await doc.getScript()).length,
}, null, 2));
await session.close();
process.exit(0);
