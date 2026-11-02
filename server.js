// Server minimo per Render: mostra la dashboard e legge le perizie con Claude.
// Nessuna libreria da installare. La chiave API si inserisce su Render, non qui.
import http from "node:http";
import { readFile } from "node:fs/promises";

const PORT = process.env.PORT || 3000;
const KEY = process.env.ANTHROPIC_API_KEY;
const MAX_TESTO = 120000;
const MAX_PDF_B64 = 28000000; // circa 20 MB di PDF // circa 40 pagine di perizia: costo comunque inferiore a mezzo centesimo

const PROMPT = `Sei un analista di crediti deteriorati garantiti da immobili. Leggi la perizia di stima qui sotto ed estrai i dati richiesti.
Rispondi SOLO con un oggetto JSON valido, senza testo prima o dopo, con queste chiavi:
- "comune": stringa
- "tribunale": stringa (solo il nome della città)
- "rge": numero della procedura esecutiva nella forma "numero/anno", oppure null
- "data_asta": data della prossima asta nel formato "AAAA-MM-GG" se indicata, altrimenti null
- "tipologia": uno tra "Appartamento", "Villetta", "Box", "Locale commerciale", "Terreno"
- "occupato": true se l'immobile è occupato dal debitore o da terzi, false se libero
- "occupazione": uno tra "libero", "debitore", "terzi_senza_titolo", "terzi_opponibile" (terzi con contratto di locazione opponibile alla procedura perché con data certa anteriore al pignoramento)
- "abusi": true se ci sono abusi o irregolarità edilizie o urbanistiche non sanate
- "abusi_sanabili": true se gli abusi sono dichiarati sanabili, false se non sanabili, null se non ci sono abusi o la perizia non lo dice
- "diritto": uno tra "piena" (piena proprietà), "quota" (quota di proprietà), "nuda" (nuda proprietà), "altro" (usufrutto, diritto di superficie o altro)
- "quota": se si vende una quota, la frazione come testo (es. "1/2"), altrimenti null
- "superficie_mq": superficie commerciale in mq, oppure null
- "piano": piano dell'immobile come testo breve (es. "2°", "terra"), oppure null
- "credito": importo in euro del credito per cui si procede, solo se indicato nel testo, altrimenti null
- "manutenzione_scarsa": true se lo stato di manutenzione è scarso o mediocre o servono lavori importanti
- "zona_alta_domanda": true se il comune è capoluogo di provincia o in un'area metropolitana con mercato dinamico; false per piccoli centri
- "prezzo_base": numero in euro (prezzo base d'asta)
- "valore_mercato": numero in euro (valore di mercato stimato prima delle riduzioni)
- "aste_deserte_prec": numero intero di tentativi di vendita precedenti andati deserti
- "evidenze": oggetto con le chiavi "occupato", "abusi", "manutenzione_scarsa", "zona_alta_domanda", "diritto", ciascuna con una citazione breve dal testo (al massimo 15 parole) che giustifica il valore
- "criticita": elenco (massimo 5) di oggetti {"titolo": problema concreto per chi compra in al massimo 10 parole, "citazione": frase breve della perizia, al massimo 15 parole}; includi spese condominiali non pagate, vincoli, servitù, difformità, costi di sanatoria o ripristino, problemi di sgombero
- "costi_extra": somma in euro dei costi a carico di chi compra indicati nella perizia (spese condominiali insolute, sanatorie, ripristini), oppure null
Se un dato manca usa null.

PERIZIA:
`;

const json = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };

async function leggiPerizia(req, res) {
  if (req.method === "GET") return json(res, 200, { ok: Boolean(KEY) });
  if (req.method !== "POST") return json(res, 405, { error: "Metodo non ammesso" });
  if (!KEY) return json(res, 500, { error: "Chiave API non configurata" });

  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > MAX_PDF_B64 + 1000) return json(res, 413, { error: "File troppo grande" }); }
  let body;
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: "Richiesta non valida" }); }
  let content;
  if (typeof body.pdf === "string" && body.pdf.length > 0) {
    // PDF scansionato: lo legge direttamente l'IA
    if (!body.pdf.startsWith("JVBER")) return json(res, 400, { error: "Il file non è un PDF" });
    content = [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: body.pdf } },
      { type: "text", text: PROMPT + "(la perizia è il documento PDF allegato)" }
    ];
  } else {
    const testo = String(body.testo || "").slice(0, MAX_TESTO);
    if (testo.length < 80) return json(res, 400, { error: "Testo della perizia troppo corto" });
    content = PROMPT + testo;
  }

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 2000, messages: [{ role: "user", content }] })
    });
    if (r.status === 429) return json(res, 429, { error: "Troppe richieste" });
    if (r.status === 400 && Array.isArray(content)) return json(res, 422, { error: "L'IA non riesce a leggere questo PDF: forse è troppo lungo o protetto" });
    if (!r.ok) return json(res, 502, { error: "Il servizio di IA non ha risposto" });
    const j = await r.json();
    const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    return json(res, 200, { dati: JSON.parse(m ? m[0] : text) });
  } catch {
    return json(res, 502, { error: "Risposta dell'IA non leggibile" });
  }
}

http.createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0];
  if (path === "/api/leggi-perizia") return leggiPerizia(req, res);
  if (path === "/" || path === "/index.html") {
    const html = await readFile(new URL("./index.html", import.meta.url));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Pagina non trovata");
}).listen(PORT, () => console.log(`Recovery Studio attivo sulla porta ${PORT}`));
