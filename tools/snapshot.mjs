// Ögonblicksbild av en app: tabeller med radantal, fält, och värdet av varje
// master measure och master dimension (antal distinkta värden). Används för
// att bevisa att en skriptändring ger exakt samma modell.
import { auth, qix } from "@qlik/api";
import { hostConfig, tenantHost } from "../auth.mjs";

process.emitWarning = () => {};
const host = tenantHost();
auth.setDefaultHostConfig(await hostConfig(host));

const appId = process.argv[2];
const session = qix.openAppSession({ appId, identity: "snapshot" });
const doc = await session.getDoc();
await doc.clearAll(true);

const { qtr } = await doc.getTablesAndKeys({ qcx: 0, qcy: 0 }, { qcx: 0, qcy: 0 }, 0, true, false);
const tables = Object.fromEntries(qtr.map((t) => [t.qName, { rows: t.qNoOfRows, fields: t.qFields.map((f) => f.qName).sort(), synthetic: !!t.qIsSynthetic }]));

// Measure-listan läser definitionen ur /qMeasure, dimensionslistan ur /qDim.
async function list(type, defPath) {
  const T = type[0].toUpperCase() + type.slice(1);
  const obj = await doc.createSessionObject({
    qInfo: { qType: `${type}List` },
    [`q${T}ListDef`]: { qType: type, qData: { title: "/qMetaDef/title", def: defPath } },
  });
  return (await obj.getLayout())[`q${T}List`].qItems;
}

const measures = {};
for (const m of await list("measure", "/qMeasure")) {
  const v = await doc.evaluateEx(m.qData.def.qDef);
  measures[m.qData.title] = v.qIsNumeric ? v.qNumber : v.qText;
}
const dimensions = {};
for (const d of await list("dimension", "/qDim")) {
  const field = d.qData.def.qFieldDefs[0];
  const v = await doc.evaluateEx(`Count(DISTINCT ${field.startsWith("=") ? field.slice(1) : field})`);
  dimensions[d.qData.title] = { field, distinct: v.qNumber };
}

console.log(JSON.stringify({ appId, tables, measures, dimensions }, null, 2));
await session.close();
process.exit(0);
