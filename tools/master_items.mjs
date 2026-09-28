// Master items with their full definitions, plus optional evaluation of
// ad-hoc expressions. Used by a naming audit (which fields do
// master items reference?) and verifier (control numbers).
//
//   node tools/master_items.mjs <appId>                       definitions + values
//   node tools/master_items.mjs <appId> --eval '<expr>' ...   also evaluate expressions
import { auth, qix } from "@qlik/api";
import { hostConfig, tenantHost } from "../auth.mjs";

process.emitWarning = () => {};
const host = tenantHost();
auth.setDefaultHostConfig(await hostConfig(host));

const [appId, ...rest] = process.argv.slice(2);
const expressions = [];
for (let i = 0; i < rest.length; i++) if (rest[i] === "--eval") expressions.push(rest[++i]);

const session = qix.openAppSession({ appId, identity: "master-items" });
const doc = await session.getDoc();
await doc.clearAll(true);

async function list(kind, defPath) {
  const T = kind === "measure" ? "Measure" : "Dimension";
  const obj = await doc.createSessionObject({
    qInfo: { qType: `${kind}-defs` },
    [`q${T}ListDef`]: { qType: kind, qData: { title: "/qMetaDef/title", description: "/qMetaDef/description", def: defPath } },
  });
  return (await obj.getLayout())[`q${T}List`].qItems;
}

const measures = [];
for (const m of await list("measure", "/qMeasure")) {
  const v = await doc.evaluateEx(m.qData.def.qDef);
  measures.push({ id: m.qInfo.qId, title: m.qData.title, description: m.qData.description ?? "", expression: m.qData.def.qDef, value: v.qIsNumeric ? v.qNumber : v.qText });
}
const dimensions = (await list("dimension", "/qDim")).map((d) => ({
  id: d.qInfo.qId,
  title: d.qData.title,
  description: d.qData.description ?? "",
  fields: d.qData.def.qFieldDefs ?? [],
}));
const evaluated = [];
for (const e of expressions) {
  const v = await doc.evaluateEx(e);
  evaluated.push({ expression: e, value: v.qIsNumeric ? v.qNumber : v.qText, numeric: !!v.qIsNumeric });
}

console.log(JSON.stringify({ appId, measures, dimensions, evaluated }, null, 2));
await session.close();
process.exit(0);
