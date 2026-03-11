import { useState, useMemo, useCallback } from "react";

// ============================================================
// SIMULATEUR CORRIGÉ — Score Composite Leleu et al. (2023)
// Calibré sur les données réelles du Tableau VI de l'article
// ============================================================

// --- REAL DATA from Leleu Table VI (PSI per 1000 hospitalizations) ---
const REAL_PSI_MEANS = {
  CHR: { PSI1: 1.0, PSI3: 32.0, PSI5: 0.0, PSI7: 3.0, PSI10: 81.0, PSI12: 18.0, PSI13: 26.0, PSI15: 11.0 },
  AUTRE: { PSI1: 0.5, PSI3: 28.0, PSI5: 0.0, PSI7: 1.5, PSI10: 20.0, PSI12: 4.5, PSI13: 7.5, PSI15: 3.5 },
  NATIONAL: { PSI1: 0.15, PSI3: 10.0, PSI5: 0.05, PSI7: 0.3, PSI10: 5.0, PSI12: 4.0, PSI13: 3.0, PSI15: 0.5 }
};

// Real RH rates from Table V (CMD 08 - musculoskeletal, most data)
const REAL_RH = {
  CHR: { RH7: 0.01, RH30: 0.04 },
  AUTRE: { RH7: 0.01, RH30: 0.035 }
};

// Real PRADO rates from Table VII (CMD 08)
const REAL_RECOURS = { INF15: 0.80, MG15: 0.32, SPE60: 0.77 };

// --- Generate realistic market with log-normal distributions ---
function generateMarket(seed, size, category) {
  const rng = mulberry32(seed);
  const means = category === "CHR" ? REAL_PSI_MEANS.CHR : REAL_PSI_MEANS.AUTRE;
  const rhMeans = category === "CHR" ? REAL_RH.CHR : REAL_RH.AUTRE;
  const gravitySensitivePSI = new Set(["PSI3", "PSI7", "PSI10", "PSI12", "PSI13"]);
  
  const hospitals = [];
  for (let i = 0; i < size; i++) {
    const h = {};
    // Shared latent severity to correlate patient-dependent PSI across indicators
    const severityShock = clamp(1 + boxMullerRng(rng) * 0.20, 0.6, 1.8);
    // PSI: log-normal around real means (CV ~0.6)
    for (const [k, mean] of Object.entries(means)) {
      const cv = 0.6;
      const sigma = Math.sqrt(Math.log(1 + cv * cv));
      const mu = Math.log(Math.max(mean, 0.1)) - sigma * sigma / 2;
       const baseDraw = Math.max(0, Math.exp(mu + sigma * boxMullerRng(rng)));
      h[k] = gravitySensitivePSI.has(k) ? baseDraw * severityShock : baseDraw;
    }
    // RH: beta-like around real means
    h.RH7 = Math.max(0, rhMeans.RH7 + (rng() - 0.5) * 0.02);
    h.RH30 = Math.max(0, rhMeans.RH30 + (rng() - 0.5) * 0.06);
    // Recours: beta-like
    h.INF15 = clamp(REAL_RECOURS.INF15 + (rng() - 0.5) * 0.4, 0, 1);
    h.MG15 = clamp(REAL_RECOURS.MG15 + (rng() - 0.5) * 0.3, 0, 1);
    h.SPE60 = clamp(REAL_RECOURS.SPE60 + (rng() - 0.5) * 0.4, 0, 1);
    hospitals.push(h);
  }
  return hospitals;
}

function mulberry32(a) {
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function boxMullerRng(rng) {
  const u1 = rng(); const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1 || 0.001)) * Math.cos(2 * Math.PI * u2);
}

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

function computeQuantiles(arr, q) {
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// --- SCORING ENGINE (faithful to Leleu methodology) ---
function classifyIndicator(value, q1, q3, inverse = false) {
  if (value == null) return "Moyen"; // missing data → impute mean
  if (!inverse) {
    if (value <= q1) return "Bon";
    if (value >= q3) return "Discutable";
    return "Moyen";
  } else {
    if (value >= q3) return "Bon";
    if (value <= q1) return "Discutable";
    return "Moyen";
  }
}

function computeScore(data, thresholds) {
  // Classify each indicator
  const classes = {};
  for (const [key, th] of Object.entries(thresholds)) {
    classes[key] = classifyIndicator(data[key], th.q1, th.q3, th.inverse);
  }

  // Sub-score: Réhospitalisation
  const rhVals = [classes.RH7, classes.RH30];
  let ssRH = "Moyen";
  if (rhVals.includes("Discutable")) ssRH = "Discutable";
  else if (rhVals.every(v => v === "Bon")) ssRH = "Bon";

  // Sub-score: Sécurité (PSI) — rule: ≥2 Discutable → Discutable
  const psiKeys = Object.keys(classes).filter(k => k.startsWith("PSI"));
  const psiVals = psiKeys.map(k => classes[k]);
  const nbPsiBad = psiVals.filter(v => v === "Discutable").length;
  let ssSecu = "Moyen";
  if (nbPsiBad >= 2) ssSecu = "Discutable";
  else if (nbPsiBad === 0) ssSecu = "Bon";

  // Sub-score: Parcours — rule: ≥2 Discutable → Discutable
  const recVals = [classes.INF15, classes.MG15, classes.SPE60];
  const nbRecBad = recVals.filter(v => v === "Discutable").length;
  let ssRec = "Moyen";
  if (nbRecBad >= 2) ssRec = "Discutable";
  else if (recVals.every(v => v === "Bon")) ssRec = "Bon";

  // Final composite
  const ssList = [ssRH, ssSecu, ssRec];
  const nbBad = ssList.filter(v => v === "Discutable").length;
  const nbGood = ssList.filter(v => v === "Bon").length;

  let grade, stars, color;
  if (nbBad >= 2) { grade = "D"; stars = 1; color = "#dc2626"; }
  else if (nbBad === 1) { grade = "C"; stars = 2; color = "#ea580c"; }
  else if (nbGood >= 2 && nbBad === 0) { grade = "A"; stars = 4; color = "#16a34a"; }
  else { grade = "B"; stars = 3; color = "#65a30d"; }

  const labels = { A: "Très Bon", B: "Bon", C: "Moyen", D: "Discutable" };

  return { grade, stars, color, label: labels[grade], ssRH, ssSecu, ssRec, classes, nbPsiBad };
}

// --- UI COMPONENTS ---
const StarDisplay = ({ stars, color }) => (
  <div style={{ fontSize: 32, letterSpacing: 2 }}>
    {[1,2,3,4].map(i => (
      <span key={i} style={{ color: i <= stars ? color : "#e5e7eb" }}>★</span>
    ))}
  </div>
);

const Badge = ({ text, type }) => {
  const colors = {
    Bon: { bg: "#dcfce7", fg: "#166534", border: "#86efac" },
    Moyen: { bg: "#fef9c3", fg: "#854d0e", border: "#fde047" },
    Discutable: { bg: "#fee2e2", fg: "#991b1b", border: "#fca5a5" },
  };
  const c = colors[type] || colors.Moyen;
  return (
    <span style={{
      display: "inline-block", padding: "2px 10px", borderRadius: 6,
      fontSize: 12, fontWeight: 600, background: c.bg, color: c.fg, border: `1px solid ${c.border}`,
    }}>{text}</span>
  );
};

const Slider = ({ label, value, onChange, min, max, step, unit = "", help }) => (
  <div style={{ marginBottom: 16 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
      <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>{label}</label>
      <span style={{ fontSize: 14, fontWeight: 700, color: "#1e40af", fontFamily: "monospace" }}>
        {typeof value === "number" ? (step < 1 ? value.toFixed(2) : value) : value}{unit}
      </span>
    </div>
    <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))}
      style={{ width: "100%", accentColor: "#2563eb", cursor: "pointer" }} />
    {help && <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>{help}</div>}
  </div>
);

const ScoreCard = ({ title, icon, description, result, details, highlight }) => (
  <div style={{
    background: "white", borderRadius: 12, padding: 24,
    border: `2px solid ${result.color}22`, boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
    display: "flex", flexDirection: "column", minHeight: 380,
  }}>
    <div style={{ textAlign: "center", marginBottom: 16 }}>
      <div style={{ fontSize: 28, marginBottom: 4 }}>{icon}</div>
      <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#111827" }}>{title}</h3>
      <p style={{ margin: "4px 0 0", fontSize: 12, color: "#6b7280", lineHeight: 1.4 }}>{description}</p>
    </div>
    
    <div style={{
      textAlign: "center", padding: "16px 0", margin: "8px 0",
      background: `${result.color}08`, borderRadius: 8, border: `1px solid ${result.color}20`,
    }}>
      <StarDisplay stars={result.stars} color={result.color} />
      <div style={{ fontSize: 18, fontWeight: 800, color: result.color, marginTop: 4 }}>{result.label}</div>
    </div>

    <div style={{ fontSize: 13, color: "#374151", flex: 1 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "6px 12px", marginBottom: 12 }}>
        <span>Sécurité (PSI)</span><Badge text={result.ssSecu} type={result.ssSecu} />
        <span>Réhospitalisation</span><Badge text={result.ssRH} type={result.ssRH} />
        <span>Parcours</span><Badge text={result.ssRec} type={result.ssRec} />
      </div>
      {details && <div style={{ fontSize: 12, color: "#6b7280", borderTop: "1px solid #f3f4f6", paddingTop: 8 }}>{details}</div>}
    </div>

    {highlight && (
      <div style={{
        marginTop: 8, padding: "8px 12px", borderRadius: 6,
        background: "#fef3c7", border: "1px solid #fde68a", fontSize: 12, color: "#92400e", lineHeight: 1.4,
      }}>
        💡 {highlight}
      </div>
    )}
  </div>
);

// --- MAIN APP ---
export default function SimulateurLeleu() {
  const [gravite, setGravite] = useState(1.8);
  const [selectivite, setSelectivite] = useState(0.85);
  const [triche, setTriche] = useState(0);
  const [showMethode, setShowMethode] = useState(false);

  // Generate separate markets for CHR and AUTRE (as per Leleu)
  const marketCHR = useMemo(() => generateMarket(42, 32, "CHR"), []);
  const marketAUTRE = useMemo(() => generateMarket(99, 468, "AUTRE"), []);

  // Compute thresholds per category
  const computeThresholds = useCallback((market) => {
    const indicators = ["PSI1","PSI3","PSI5","PSI7","PSI10","PSI12","PSI13","PSI15","RH7","RH30","INF15","MG15","SPE60"];
    const th = {};
    for (const ind of indicators) {
      const vals = market.map(h => h[ind]).filter(v => v != null);
      const inverse = ["INF15","MG15","SPE60"].includes(ind);
      th[ind] = {
        q1: computeQuantiles(vals, 0.25),
        q3: computeQuantiles(vals, 0.75),
        inverse,
      };
    }
    return th;
  }, []);

  const thCHR = useMemo(() => computeThresholds(marketCHR), [marketCHR, computeThresholds]);
  const thAUTRE = useMemo(() => computeThresholds(marketAUTRE), [marketAUTRE, computeThresholds]);

  // SCENARIO A: CHU with severity bias (evaluated against CHR thresholds)
  const chuData = useMemo(() => {
    const base = { ...REAL_PSI_MEANS.CHR };
    // Gravity multiplier on patient-dependent PSIs
    return {
      PSI1: base.PSI1, PSI3: base.PSI3 * gravite, PSI5: base.PSI5,
      PSI7: base.PSI7 * gravite, PSI10: base.PSI10 * gravite,
      PSI12: base.PSI12 * gravite, PSI13: base.PSI13 * gravite, PSI15: base.PSI15,
      RH7: 0.012 * gravite, RH30: 0.04 * gravite,
      INF15: 0.75, MG15: 0.30, SPE60: 0.70,
    };
  }, [gravite]);

  // SCENARIO B: Selective clinic (evaluated against AUTRE thresholds)
  const cliniqueData = useMemo(() => {
    const factor = 1 - selectivite;
    return {
      PSI1: REAL_PSI_MEANS.AUTRE.PSI1 * factor,
      PSI3: REAL_PSI_MEANS.AUTRE.PSI3 * factor,
      PSI5: 0, PSI7: REAL_PSI_MEANS.AUTRE.PSI7 * factor,
      PSI10: REAL_PSI_MEANS.AUTRE.PSI10 * factor,
      PSI12: REAL_PSI_MEANS.AUTRE.PSI12 * factor,
      PSI13: REAL_PSI_MEANS.AUTRE.PSI13 * factor,
      PSI15: REAL_PSI_MEANS.AUTRE.PSI15 * factor,
      RH7: 0.005 + 0.01 * factor, RH30: 0.02 + 0.03 * factor,
      INF15: 0.92, MG15: 0.80, SPE60: 0.90,
    };
  }, [selectivite]);

  // SCENARIO C: Moral hazard — undercoding (evaluated against AUTRE)
  const realPSI = REAL_PSI_MEANS.AUTRE;
  const imposteurData = useMemo(() => {
    const factor = 1 - triche / 100;
    return {
      PSI1: realPSI.PSI1, PSI3: realPSI.PSI3,
      PSI5: realPSI.PSI5, PSI7: (realPSI.PSI7 * 3) * factor, // actual is 3x worse than average
      PSI10: (realPSI.PSI10 * 2.5) * factor,
      PSI12: (realPSI.PSI12 * 2) * factor,
      PSI13: (realPSI.PSI13 * 3) * factor,
      PSI15: realPSI.PSI15,
      RH7: 0.015, RH30: 0.045,
      INF15: 0.65, MG15: 0.30, SPE60: 0.60,
    };
  }, [triche]);

  const scoreCHU = useMemo(() => computeScore(chuData, thCHR), [chuData, thCHR]);
  const scoreClinique = useMemo(() => computeScore(cliniqueData, thAUTRE), [cliniqueData, thAUTRE]);
  const scoreImposteur = useMemo(() => computeScore(imposteurData, thAUTRE), [imposteurData, thAUTRE]);

  // Also compute imposteur without cheating for comparison
  const imposteurSansTriche = useMemo(() => {
    const d = {
      PSI1: realPSI.PSI1, PSI3: realPSI.PSI3, PSI5: realPSI.PSI5,
      PSI7: realPSI.PSI7 * 3, PSI10: realPSI.PSI10 * 2.5,
      PSI12: realPSI.PSI12 * 2, PSI13: realPSI.PSI13 * 3, PSI15: realPSI.PSI15,
      RH7: 0.015, RH30: 0.045, INF15: 0.65, MG15: 0.30, SPE60: 0.60,
    };
    return computeScore(d, thAUTRE);
  }, [thAUTRE]);

  return (
    <div style={{
      fontFamily: "'Söhne', -apple-system, sans-serif",
      background: "#f8fafc", minHeight: "100vh", padding: "24px 16px",
    }}>
      {/* Header */}
      <div style={{ maxWidth: 1100, margin: "0 auto 24px", textAlign: "center" }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: "#0f172a", margin: 0, letterSpacing: -0.5 }}>
          Simulateur — Score Composite Leleu et al. (2023)
        </h1>
        <p style={{ color: "#64748b", fontSize: 13, margin: "8px 0 0", lineHeight: 1.5 }}>
          Illustration des vulnérabilités théoriques du modèle face aux comportements stratégiques.
          <br />
          <span style={{ fontSize: 11, fontStyle: "italic" }}>
            Calibré sur les données réelles du Tableau VI de l'article (PSI pour 1 000 hospitalisations).
            Seuils Q1/Q3 calculés séparément pour CHR/CHU et Autres, conformément à la section 2.4.3.
          </span>
        </p>
        <button onClick={() => setShowMethode(!showMethode)} style={{
          marginTop: 8, padding: "4px 14px", borderRadius: 6, border: "1px solid #cbd5e1",
          background: "white", fontSize: 12, color: "#475569", cursor: "pointer",
        }}>
          {showMethode ? "Masquer" : "Voir"} la méthodologie
        </button>
      </div>

      {showMethode && (
        <div style={{
          maxWidth: 1100, margin: "0 auto 20px", padding: 20, background: "white",
          borderRadius: 10, border: "1px solid #e2e8f0", fontSize: 13, color: "#334155", lineHeight: 1.6,
        }}>
          <strong>Marché de référence :</strong> 32 établissements CHR/CHU + 468 autres, générés par distributions log-normales centrées sur les moyennes observées (article, Tab. VI). Les PSI sont corrélés via un facteur de gravité commun.
          <br /><strong>Seuils :</strong> Q1 (25e percentile) = « Bon », Q3 (75e percentile) = « Discutable », calculés séparément par catégorie.
          <br /><strong>Règles d'agrégation :</strong> Fidèles à l'Encadré 2 de l'article. ≥2 PSI Discutable → sous-score Discutable. ≥2 sous-scores Discutable → score final D (Discutable).
          <br /><strong>Statut épistémologique :</strong> Cette simulation <em>illustre</em> des vulnérabilités théoriques. Elle ne <em>démontre</em> pas leur existence empirique, qui nécessiterait des données SNDS réelles.
        </div>
      )}

      {/* Controls + Cards */}
      <div style={{ maxWidth: 1100, margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
        {/* Column A: CHU */}
        <div>
          <div style={{ background: "white", borderRadius: 10, padding: 16, marginBottom: 16, border: "1px solid #e2e8f0" }}>
            <h4 style={{ margin: "0 0 12px", fontSize: 14, color: "#1e3a5f" }}>⚙️ Paramètres CHU</h4>
            <Slider label="Gravité du case-mix" value={gravite} onChange={setGravite}
              min={0.5} max={3.0} step={0.1} unit="×"
              help="Multiplicateur sur les PSI liés à l'état du patient (10, 12, 13)" />
          </div>
          <ScoreCard
            title="Grand CHU" icon="🏥"
            description="Évalué contre les seuils CHR/CHU. PSI physiologiques amplifiés par la gravité des patients."
            result={scoreCHU}
            details={
              <div>
                <div>PSI 10 (métabol.) : <strong>{chuData.PSI10.toFixed(1)}</strong> / seuil Q3 : {thCHR.PSI10.q3.toFixed(1)}</div>
                <div>PSI 13 (sepsis) : <strong>{chuData.PSI13.toFixed(1)}</strong> / seuil Q3 : {thCHR.PSI13.q3.toFixed(1)}</div>
                <div style={{ marginTop: 4 }}>PSI « Discutable » : {scoreCHU.nbPsiBad}/8</div>
              </div>
            }
            highlight={gravite >= 1.5 && scoreCHU.grade === "D"
              ? "Malgré une bonne qualité chirurgicale, le CHU est pénalisé par la gravité de ses patients."
              : gravite < 1.3 ? "À gravité modérée, les seuils CHR absorbent le biais." : null}
          />
        </div>

        {/* Column B: Clinique */}
        <div>
          <div style={{ background: "white", borderRadius: 10, padding: 16, marginBottom: 16, border: "1px solid #e2e8f0" }}>
            <h4 style={{ margin: "0 0 12px", fontSize: 14, color: "#1e3a5f" }}>⚙️ Paramètres Clinique</h4>
            <Slider label="Taux de sélection" value={selectivite} onChange={setSelectivite}
              min={0} max={0.95} step={0.05} unit=""
              help="Part des cas complexes refusés (cream skimming)" />
          </div>
          <ScoreCard
            title="Clinique Sélect" icon="💎"
            description="Évaluée contre les seuils Autres. Minimise les PSI par sélection des patients sains."
            result={scoreClinique}
            details={
              <div>
                <div>PSI 13 (sepsis) : <strong>{cliniqueData.PSI13.toFixed(1)}</strong> / seuil Q1 : {thAUTRE.PSI13.q1.toFixed(1)}</div>
                <div style={{ marginTop: 4 }}>PSI « Discutable » : {scoreClinique.nbPsiBad}/8</div>
              </div>
            }
            highlight={scoreClinique.grade === "A"
              ? "Le score récompense la sélection de clientèle, pas l'excellence médicale."
              : null}
          />
        </div>

        {/* Column C: Imposteur */}
        <div>
          <div style={{ background: "white", borderRadius: 10, padding: 16, marginBottom: 16, border: "1px solid #e2e8f0" }}>
            <h4 style={{ margin: "0 0 12px", fontSize: 14, color: "#1e3a5f" }}>⚙️ Paramètres Aléa Moral</h4>
            <Slider label="Sous-codage des complications" value={triche} onChange={setTriche}
              min={0} max={80} step={5} unit="%"
              help="Part des complications non déclarées dans le PMSI" />
          </div>
          <ScoreCard
            title="L'Imposteur" icon="🎭"
            description="Hôpital médiocre (PSI réels 2-3× la moyenne) qui sous-déclare ses complications."
            result={scoreImposteur}
            details={
              <div>
                <div>PSI 7 réel : <strong>{(realPSI.PSI7 * 3).toFixed(1)}</strong> → déclaré : <strong>{imposteurData.PSI7.toFixed(1)}</strong></div>
                <div>PSI 13 réel : <strong>{(realPSI.PSI13 * 3).toFixed(1)}</strong> → déclaré : <strong>{imposteurData.PSI13.toFixed(1)}</strong></div>
                <div style={{ marginTop: 4 }}>
                  Sous-score Sécurité — Sans triche : <Badge text={imposteurSansTriche.ssSecu} type={imposteurSansTriche.ssSecu} />
                  → Avec {triche}% : <Badge text={scoreImposteur.ssSecu} type={scoreImposteur.ssSecu} />
                </div>
                <div style={{ marginTop: 4 }}>
                  Score global — Sans triche : <Badge text={imposteurSansTriche.label} type={imposteurSansTriche.label === "Très Bon" ? "Bon" : imposteurSansTriche.label} />
                  → Avec {triche}% : <Badge text={scoreImposteur.label} type={scoreImposteur.label === "Très Bon" ? "Bon" : scoreImposteur.label} />
                </div>
              </div>
            }
            highlight={scoreImposteur.grade !== imposteurSansTriche.grade
              ? `${triche}% de sous-codage suffit à changer le score global de ${imposteurSansTriche.label} à ${scoreImposteur.label}.`
              : triche > 0 && scoreImposteur.ssSecu !== imposteurSansTriche.ssSecu
                ? `Le sous-codage peut améliorer le sous-score Sécurité sans forcément changer le score global (Réhospitalisation et Parcours restent inchangés).`
                : null}
          />
        </div>
      </div>

      {/* Synthesis */}
      <div style={{
        maxWidth: 1100, margin: "24px auto 0", padding: 20, background: "white",
        borderRadius: 10, border: "1px solid #e2e8f0",
      }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 700, color: "#0f172a" }}>
          Synthèse des vulnérabilités illustrées
        </h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, fontSize: 13, color: "#334155", lineHeight: 1.5 }}>
          <div>
            <strong style={{ color: "#1e3a5f" }}>Biais de sévérité</strong>
            <p style={{ margin: "4px 0" }}>
              La distinction CHR/Autre atténue le biais, mais ne l'élimine pas pour les CHU recevant les cas les plus lourds (polytraumatisés, réanimation). L'article le reconnaît (p. 62) : un ajustement par GHM serait nécessaire mais l'EGB ne le permet pas.
            </p>
          </div>
          <div>
            <strong style={{ color: "#1e3a5f" }}>Écrémage (Cream Skimming)</strong>
            <p style={{ margin: "4px 0" }}>
              Un établissement qui sélectionne ses patients obtient mécaniquement de meilleurs PSI. Le positionnement relatif (Q1/Q3) ne suffit pas si la sélection est systématique dans un segment du marché.
            </p>
          </div>
          <div>
            <strong style={{ color: "#1e3a5f" }}>Aléa moral (Gaming)</strong>
            <p style={{ margin: "4px 0" }}>
              Le score repose sur des données auto-déclarées (codage PMSI). Un sous-codage modéré peut suffire à franchir les seuils. Les données doivent pouvoir être « collectées et contrôlées ».
            </p>
          </div>
        </div>
      </div>

      <div style={{ textAlign: "center", padding: "16px 0", fontSize: 11, color: "#94a3b8" }}>
        Simulation pédagogique — MBA Executive Santé, Dauphine-PSL — Module Économie de la santé (Th. Renaud)
      </div>
    </div>
  );
}
