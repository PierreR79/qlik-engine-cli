// Autentisering mot Qlik Cloud, ett ställe för alla verktyg här.
//
// ## Varför OAuth och inte en API-nyckel
//
// Tenantens `max_api_key_expiry` är `PT24H`. En API-nyckel dör alltså mitt i
// arbetet, och gjorde det: en körning som fungerade på förmiddagen gav 401 på
// eftermiddagen, utan att något annat hade ändrats. Taket går att höja, men
// det löser fel problem.
//
// En maskinklient (OAuth M2M, `client_credentials`) har en hemlighet som inte
// löper ut på ett dygn, och växlar den mot en färsk kortlivad token vid varje
// körning. Den agerar dessutom som sig själv i stället för som användaren med alla
// dennes roller, `TenantAdmin` inräknad — ett verktyg som bara ska läsa ark
// behöver inte kunna ändra tenantens säkerhetsinställningar.
//
// API-nyckeln finns kvar som reserv, så att ingenting slutar fungera medan
// klienten skapas.
//
// ## Varför `authType: "apikey"` även för OAuth
//
// SDK:ns apikey-läge sätter `Authorization: Bearer <värdet>`. En access token
// ÄR en bearer-token, så samma läge bär båda. Att lägga till ett OAuth-läge i
// SDK-konfigurationen hade gett samma header via mer kod.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const OAUTH_SERVICE = "qlik-oauth";     // lösenordet är "<client_id>:<client_secret>"
const APIKEY_SERVICE = "qlik-api-key";  // reserv

/** Läser ett Keychain-lösenord, eller null om posten inte finns. */
function keychain(service, account) {
  try {
    return execFileSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Växlar klienthemligheten mot en access token. */
async function tokenFromClient(host, clientId, clientSecret) {
  const r = await fetch(`https://${host}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });
  if (!r.ok) {
    const kropp = (await r.text()).slice(0, 300);
    throw new Error(
      `OAuth-token nekades (${r.status}) för ${host}: ${kropp}\n` +
      "Kontrollera att maskinklienten finns och att dess scopes räcker.",
    );
  }
  const { access_token: token } = await r.json();
  if (!token) throw new Error(`OAuth-svaret för ${host} saknade access_token.`);
  return token;
}

let cachad = null;  // en token per process räcker; inget skrivs till disk

/**
 * Bearer-token för tenanten. OAuth först, API-nyckel som reserv.
 *
 * Token cachas i processen men aldrig på disk: den är en hemlighet, och en fil
 * i hemkatalogen skyddas inte som Keychain gör. Priset är ett extra
 * HTTP-anrop per körning.
 */
export async function bearer(host) {
  if (cachad?.host === host) return cachad.token;

  const par = keychain(OAUTH_SERVICE, host);
  if (par) {
    const i = par.indexOf(":");
    if (i < 1 || i === par.length - 1) {
      throw new Error(
        `Keychain-posten ${OAUTH_SERVICE} för ${host} har fel form. ` +
        "Den ska vara <client_id>:<client_secret>.",
      );
    }
    const clientId = par.slice(0, i);
    // Att kopiera fältet i Qliks dialog tar med etiketten: posten blir
    // "Client ID:<id>:<secret>" och tenanten svarar OAUTH-14 på ordet
    // "Client ID". Fånga det här i stället för efter ett nätverksanrop.
    if (/\s/.test(clientId)) {
      throw new Error(
        `Keychain-posten ${OAUTH_SERVICE} för ${host} börjar med ` +
        `"${clientId.trim()}", vilket ser ut som en etikett från Qliks dialog ` +
        "och inte som ett client_id.\nKopiera de två värdena var för sig; " +
        "posten ska vara exakt <client_id>:<client_secret>.",
      );
    }
    const token = await tokenFromClient(host, clientId, par.slice(i + 1));
    cachad = { host, token };
    return token;
  }

  const nyckel = keychain(APIKEY_SERVICE, host);
  if (nyckel) {
    cachad = { host, token: nyckel };
    return nyckel;
  }

  throw new Error(
    `Inga Qlik-uppgifter i Keychain för ${host}.\n\n` +
    "Skapa en maskinklient i Qlik (Administration → Integrations → OAuth →\n" +
    "Create new, typ \"Web/Machine to machine\"), och spara den så här:\n\n" +
    `  security add-generic-password -U -s ${OAUTH_SERVICE} -a ${host} -w "<client_id>:<client_secret>"\n\n` +
    `Alternativt en API-nyckel under tjänsten ${APIKEY_SERVICE} — men den ` +
    "löper ut efter ett dygn i den här tenanten.",
  );
}

/** Färdig hostConfig till @qlik/api. */
export async function hostConfig(host) {
  return { authType: "apikey", host, apiKey: await bearer(host) };
}

/**
 * Tenantens host, t.ex. "<tenant>.<region>.qlikcloud.com".
 * Miljövariabeln QLIK_HOST går före qlik.config.json (som inte versioneras).
 */
export function tenantHost() {
  if (process.env.QLIK_HOST) return process.env.QLIK_HOST;
  const fil = new URL("./qlik.config.json", import.meta.url);
  if (existsSync(fil)) return JSON.parse(readFileSync(fil, "utf8")).host;
  throw new Error(
    "Ingen tenant angiven. Sätt QLIK_HOST, eller kopiera qlik.config.example.json\n" +
    "till qlik.config.json och skriv in din host.",
  );
}
