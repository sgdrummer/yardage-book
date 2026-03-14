import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ScatterChart, Scatter, ReferenceLine, BarChart, Bar, Cell, Legend
} from "recharts";

// ── Constants ────────────────────────────────────────────────
const CLUBS = ["Driver", "5H", "6I", "7I", "8I", "9I", "PW", "SW"];
const CLUB_COLORS = {
  Driver: "#c9982a", "5H": "#2d7a3a", "6I": "#1a5fa8", "7I": "#c05c1a",
  "8I": "#7b3fa0", "9I": "#1a8a7a", PW: "#b01a50", SW: "#4a6070",
};
const CLUB_LIGHT = {
  Driver: "#fff8e6", "5H": "#edf7ef", "6I": "#e6f0fa", "7I": "#fdf0e6",
  "8I": "#f5edfb", "9I": "#e6f7f5", PW: "#fce6ee", SW: "#edf2f5",
};
const STORAGE_KEY = "yardage-book-v2-yards";

// All distances stored and displayed in YARDS natively
// Ball speed in mph, height in feet, offline/curve in yards

// Ideal launch angles by ball speed (mph) — based on TrackMan data
const IDEAL_LAUNCH = [
  { maxSpeed: 78,  angle: 16 }, { maxSpeed: 94,  angle: 18 },
  { maxSpeed: 112, angle: 20 }, { maxSpeed: 130, angle: 22 },
  { maxSpeed: 145, angle: 24 }, { maxSpeed: 999, angle: 26 },
];
const idealLaunch = speed => {
  if (!speed) return null;
  return (IDEAL_LAUNCH.find(r => speed <= r.maxSpeed) || IDEAL_LAUNCH.at(-1)).angle;
};

const FIELDS = [
  { key: "flatCarry",    label: "Flat Carry",    unit: "yd",  required: true },
  { key: "distanceTrend",label: "Dist. Trend",   unit: "yd"  },
  { key: "ballSpeed",    label: "Ball Speed",    unit: "mph" },
  { key: "launchAngle",  label: "Launch °",      unit: "°"   },
  { key: "height",       label: "Height",        unit: "ft"  },
  { key: "landingAngle", label: "Landing °",     unit: "°"   },
  { key: "hangTime",     label: "Hang Time",     unit: "s"   },
];

function emptyShot() {
  return { flatCarry:"", distanceTrend:"", ballSpeed:"", launchAngle:"", height:"", landingAngle:"", hangTime:"", curve:"", curveDir:"L", offline:"", offlineDir:"L", mishitOverride:null };
}

function statOf(shots, key) {
  const vals = shots.map(s => s[key]).filter(v => v != null && !isNaN(Number(v))).map(Number);
  if (!vals.length) return null;
  const avg = vals.reduce((a,b)=>a+b,0)/vals.length;
  const std = Math.sqrt(vals.reduce((a,b)=>a+Math.pow(b-avg,2),0)/vals.length);
  return { avg:+(avg.toFixed(1)), best:Math.max(...vals), worst:Math.min(...vals), std:Math.round(std), count:vals.length, vals };
}

function calcMishit(shot, allShots) {
  if (!shot.flatCarry) return false;
  const carries = allShots.filter(s=>s.flatCarry).map(s=>Number(s.flatCarry));
  if (carries.length < 3) return false;
  const avg = carries.reduce((a,b)=>a+b,0)/carries.length;
  return Number(shot.flatCarry) < avg * 0.85;
}

function applyFlags(shots) {
  return shots.map(sh => ({
    ...sh,
    mishit: sh.mishitOverride != null ? sh.mishitOverride : calcMishit(sh, shots),
  }));
}

function calcStreak(shots) {
  let current = 0, best = 0, run = 0;
  shots.forEach(sh => {
    if (!sh.mishit) { run++; best = Math.max(best, run); }
    else run = 0;
  });
  // current streak from end
  for (let i = shots.length - 1; i >= 0; i--) {
    if (!shots[i].mishit) current++; else break;
  }
  return { current, best };
}

// ── Storage ──────────────────────────────────────────────────
function lsSave(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); return true; } catch { return false; }
}
function lsLoad() {
  try { const v = localStorage.getItem(STORAGE_KEY); return v ? JSON.parse(v) : null; } catch { return null; }
}

// ── Main Component ───────────────────────────────────────────
export default function YardageBook() {
  const [sessions, setSessions] = useState([]);
  const [club, setClub] = useState("SW");
  const [tab, setTab] = useState("log");
  const [logView, setLogView] = useState("add");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [sessName, setSessName] = useState("");
  const [weather, setWeather] = useState("");
  const [notes, setNotes] = useState("");
  const [shot, setShot] = useState(emptyShot());
  const [bulk, setBulk] = useState("");
  const [bulkMode, setBulkMode] = useState(false);
  const [mishitsOnly, setMishitsOnly] = useState(false);
  const [expandedSess, setExpandedSess] = useState(null);
  const [compareA, setCompareA] = useState(null);
  const [compareB, setCompareB] = useState(null);
  const [saved, setSaved] = useState("idle");
  const importRef = useRef();

  // Load
  useEffect(() => {
    const data = lsLoad();
    if (data?.sessions) setSessions(data.sessions);
    else if (Array.isArray(data)) setSessions(data);
  }, []);

  // Save
  useEffect(() => {
    if (!sessions.length && !lsLoad()) return;
    setSaved("saving");
    const t = setTimeout(() => {
      const ok = lsSave({ sessions, version: 1 });
      setSaved(ok ? "saved" : "error");
      if (ok) setTimeout(() => setSaved("idle"), 2000);
    }, 400);
    return () => clearTimeout(t);
  }, [sessions]);

  // Export JSON
  function exportData() {
    const blob = new Blob([JSON.stringify({ sessions, version:1, exportedAt: new Date().toISOString() }, null, 2)], { type:"application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href=url; a.download="yardage-book.json"; a.click();
    URL.revokeObjectURL(url);
  }

  // Import JSON
  function importData(e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);
        const imported = data.sessions || (Array.isArray(data) ? data : null);
        if (imported) { setSessions(imported); alert(`✓ Imported ${imported.length} sessions`); }
        else alert("Invalid file format");
      } catch { alert("Could not read file"); }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  // Session management
  function getSession() {
    const label = sessName.trim() || `Session ${sessions.length+1}`;
    const ex = sessions.find(s => s.date===date && s.label===label);
    if (ex) return ex.id;
    const id = Date.now();
    setSessions(p => [...p, { id, date, label, weather, notes, shots:{} }]);
    return id;
  }

  function commitShots(newShots) {
    const id = getSession();
    setSessions(p => p.map(s => {
      if (s.id !== id) return s;
      const merged = [...(s.shots[club]||[]), ...newShots];
      return { ...s, shots:{ ...s.shots, [club]: applyFlags(merged) } };
    }));
  }

  function addSingle() {
    const carry = parseFloat(shot.flatCarry);
    if (!carry || carry < 10 || carry > 400) return;
    const sh = {
      id: Date.now()+Math.random(),
      ...Object.fromEntries(FIELDS.map(f=>[f.key, shot[f.key]===""?null:parseFloat(shot[f.key])])),
      curve: shot.curve===""?null:parseFloat(shot.curve), curveDir:shot.curveDir,
      offline: shot.offline===""?null:parseFloat(shot.offline), offlineDir:shot.offlineDir,
      mishitOverride: shot.mishitOverride,
    };
    commitShots([sh]);
    setShot(emptyShot());
    setLogView("shots");
  }

  function addBulk() {
    const pDir = val => {
      if (!val) return { v:null, d:"L" };
      const m = String(val).match(/^([LR])?(\d+\.?\d*)([LR])?$/i);
      if (!m) return { v:parseFloat(val)||null, d:"L" };
      return { v:parseFloat(m[2]), d:(m[1]||m[3]||"L").toUpperCase() };
    };
    const shots = bulk.trim().split("\n").filter(Boolean).map((line,i) => {
      const p = line.trim().split(/[\s,\t]+/);
      const c=pDir(p[7]), o=pDir(p[8]);
      return { id:Date.now()+i+Math.random(), flatCarry:parseFloat(p[0])||null, distanceTrend:parseFloat(p[1])||null, ballSpeed:parseFloat(p[2])||null, launchAngle:parseFloat(p[3])||null, height:parseFloat(p[4])||null, landingAngle:parseFloat(p[5])||null, hangTime:parseFloat(p[6])||null, curve:c.v, curveDir:c.d, offline:o.v, offlineDir:o.d, mishitOverride:null };
    }).filter(s=>s.flatCarry);
    if (!shots.length) return;
    commitShots(shots);
    setBulk(""); setBulkMode(false); setLogView("shots");
  }

  function toggleMishit(sessId, cl, shotId) {
    setSessions(p => p.map(s => {
      if (s.id!==sessId) return s;
      const shots = (s.shots[cl]||[]).map(sh => {
        if (sh.id!==shotId) return sh;
        const cur = sh.mishitOverride!=null ? sh.mishitOverride : calcMishit(sh, s.shots[cl]);
        return { ...sh, mishitOverride:!cur, mishit:!cur };
      });
      return { ...s, shots:{ ...s.shots, [cl]:shots } };
    }));
  }

  function deleteShot(sessId, cl, shotId) {
    setSessions(p => p.map(s => {
      if (s.id!==sessId) return s;
      const shots = (s.shots[cl]||[]).filter(sh=>sh.id!==shotId);
      const ns = { ...s.shots, [cl]:shots };
      if (!shots.length) delete ns[cl];
      return { ...s, shots:ns };
    }).filter(s=>Object.keys(s.shots).length>0));
  }

  // Derived data
  const allShots = useMemo(() => sessions.flatMap(s =>
    (s.shots[club]||[]).map(sh=>({ ...sh, sessId:s.id, sessLabel:s.label, sessDate:s.date }))
  ), [sessions, club]);

  const solid = allShots.filter(s=>!s.mishit);
  const mishits = allShots.filter(s=>s.mishit);
  const mishitRate = allShots.length ? Math.round(mishits.length/allShots.length*100) : 0;

  const sStats = useMemo(()=>({
    flatCarry: statOf(solid,"flatCarry"), ballSpeed: statOf(solid,"ballSpeed"),
    launchAngle: statOf(solid,"launchAngle"), height: statOf(solid,"height"),
    landingAngle: statOf(solid,"landingAngle"), hangTime: statOf(solid,"hangTime"),
    offline: statOf(solid,"offline"),
  }), [solid]);

  const mStats = useMemo(()=>({
    flatCarry: statOf(mishits,"flatCarry"), ballSpeed: statOf(mishits,"ballSpeed"), launchAngle: statOf(mishits,"launchAngle"),
  }), [mishits]);

  const streaks = useMemo(()=>calcStreak(allShots), [allShots]);

  const personalBests = useMemo(()=>({
    carry: solid.length ? Math.round(Math.max(...solid.map(s=>s.flatCarry||0))) : null,
    ballSpeed: solid.length ? Math.max(...solid.filter(s=>s.ballSpeed).map(s=>s.ballSpeed)) : null,
    streak: streaks.best,
  }), [solid, streaks]);

  const trendData = useMemo(()=>sessions.filter(s=>(s.shots[club]||[]).length>0).map(s=>{
    const shots=s.shots[club], sol=shots.filter(sh=>!sh.mishit);
    return {
      label: s.label.length>9?s.label.slice(0,9)+"…":s.label,
      avgCarry: sol.length?Math.round(sol.reduce((a,b)=>a+(b.flatCarry||0),0)/sol.length):null,
      bestCarry: sol.length?Math.round(Math.max(...sol.map(sh=>sh.flatCarry||0))):null,
      mishitPct: Math.round(shots.filter(sh=>sh.mishit).length/shots.length*100),
      avgBallSpeed: sol.length&&sol.some(s=>s.ballSpeed) ? +(sol.filter(s=>s.ballSpeed).reduce((a,b)=>a+b.ballSpeed,0)/sol.filter(s=>s.ballSpeed).length).toFixed(1) : null,
    };
  }), [sessions, club]);

  // Club gapping — avg carry for each club across all sessions
  const gapData = useMemo(()=>CLUBS.map(cl=>{
    const allSolid = sessions.flatMap(s=>(s.shots[cl]||[]).filter(sh=>!sh.mishit));
    const avg = allSolid.length ? Math.round(allSolid.reduce((a,b)=>a+(b.flatCarry||0),0)/allSolid.length) : null;
    return { club:cl, avg, count:allSolid.length, color:CLUB_COLORS[cl] };
  }).filter(d=>d.avg), [sessions]);

  // Shot shape data — offline (x) and how far (y = flatCarry yards)
  const shapeData = useMemo(()=>allShots.map((sh,i)=>({
    x: sh.offline==null ? 0 : (sh.offlineDir==="R" ? sh.offline : -sh.offline),
    y: Math.round(sh.flatCarry),
    mishit: sh.mishit,
    id: i,
  })), [allShots]);

  // Compare sessions
  const compareSessions = useMemo(()=>{
    const sessA = sessions.find(s=>s.id===compareA);
    const sessB = sessions.find(s=>s.id===compareB);
    if (!sessA||!sessB) return null;
    const statsFor = sess => {
      const shots = (sess.shots[club]||[]).filter(s=>!s.mishit);
      return { carry: statOf(shots,"flatCarry"), ballSpeed: statOf(shots,"ballSpeed"), launchAngle: statOf(shots,"launchAngle"), mishitRate: (sess.shots[club]||[]).length ? Math.round((sess.shots[club]||[]).filter(s=>s.mishit).length/(sess.shots[club]||[]).length*100) : 0, count:(sess.shots[club]||[]).length };
    };
    return { a:{ ...statsFor(sessA), label:sessA.label, date:sessA.date }, b:{ ...statsFor(sessB), label:sessB.label, date:sessB.date } };
  }, [sessions, compareA, compareB, club]);

  const idealLA = sStats.ballSpeed ? idealLaunch(sStats.ballSpeed.avg) : null;
  const cc = CLUB_COLORS[club];
  const cb = CLUB_LIGHT[club];
  const displayShots = mishitsOnly ? mishits : allShots;

  // ── Styles ──
  const card = { background:"#fff", borderRadius:16, padding:"16px", border:"1px solid #eaecef", boxShadow:"0 2px 8px rgba(0,0,0,0.06)", marginBottom:12 };
  const inp = { background:"#f7f8fa", border:"1.5px solid #e0e3e8", borderRadius:9, color:"#111", padding:"10px 12px", fontFamily:"inherit", fontSize:16, width:"100%", boxSizing:"border-box" };
  const lbl = { fontSize:11, fontWeight:700, color:"#666", display:"block", marginBottom:4, textTransform:"uppercase", letterSpacing:"0.05em" };
  const pill = (active, col) => ({ background:active?col:"#fff", color:active?"#fff":col, border:`2px solid ${col}`, borderRadius:20, padding:"5px 14px", fontFamily:"inherit", fontSize:13, fontWeight:700, cursor:"pointer", whiteSpace:"nowrap", boxShadow:active?`0 2px 8px ${col}44`:"none" });
  const tabBtn = (active) => ({ flex:1, background:active?"#fff":"transparent", color:active?"#1a2e22":"#8aaa8a", border:"none", borderRadius:"8px 8px 0 0", fontFamily:"inherit", fontSize:11, fontWeight:700, padding:"8px 2px", cursor:"pointer" });
  const subTab = (active) => ({ flex:1, background:active?cc:"#f0f2f5", color:active?"#fff":"#666", border:"none", borderRadius:8, padding:"9px 6px", fontFamily:"inherit", fontSize:13, fontWeight:700, cursor:"pointer" });
  const statBox = (val, label, col) => (
    <div style={{ background:"#f7f8fa", borderRadius:10, padding:"10px 6px", textAlign:"center" }}>
      <div style={{ fontSize:18, fontWeight:800, color:col, fontFamily:"monospace" }}>{val}</div>
      <div style={{ fontSize:9, fontWeight:700, color:"#aaa", letterSpacing:"0.1em", marginTop:2 }}>{label}</div>
    </div>
  );

  const savedInfo = { idle:{t:"",c:"transparent"}, saving:{t:"Saving…",c:"#e67e22"}, saved:{t:"✓ Saved",c:"#2e7d32"}, error:{t:"⚠ Error",c:"#c0392b"} }[saved];

  return (
    <div style={{ minHeight:"100vh", background:"#f0f3f7", fontFamily:"'Segoe UI',system-ui,sans-serif", color:"#111", maxWidth:500, margin:"0 auto" }}>

      {/* ── Header ── */}
      <div style={{ background:"linear-gradient(160deg,#1a2e22 0%,#0f1e15 100%)", color:"#fff", padding:"16px 16px 0", position:"sticky", top:0, zIndex:100, boxShadow:"0 3px 16px rgba(0,0,0,0.3)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:38, height:38, background:"linear-gradient(135deg,#c9982a,#e8c060)", borderRadius:10, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>⛳</div>
            <div>
              <div style={{ fontSize:20, fontWeight:800, letterSpacing:"-0.5px" }}>Yardage Book</div>
              <div style={{ fontSize:11, color:"#7aaa7a", marginTop:1 }}>
                {sessions.length} session{sessions.length!==1?"s":""} · {sessions.reduce((a,s)=>a+Object.values(s.shots).flat().length,0)} shots
              </div>
            </div>
          </div>
          <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:5 }}>
            <div style={{ fontSize:11, fontWeight:700, color:savedInfo.c }}>{savedInfo.t}</div>
            <div style={{ display:"flex", gap:6 }}>
              <button onClick={exportData} style={{ background:"#2d4a35", border:"none", color:"#8fcc8f", borderRadius:6, padding:"5px 10px", fontSize:11, fontWeight:700, fontFamily:"inherit", cursor:"pointer" }}>Export</button>
              <button onClick={()=>importRef.current.click()} style={{ background:"#2d4a35", border:"none", color:"#8fcc8f", borderRadius:6, padding:"5px 10px", fontSize:11, fontWeight:700, fontFamily:"inherit", cursor:"pointer" }}>Import</button>
              <input ref={importRef} type="file" accept=".json" onChange={importData} style={{ display:"none" }} />
            </div>
          </div>
        </div>
        {/* Tabs */}
        <div style={{ display:"flex" }}>
          {[["log","📋 Log"],["stats","📊 Stats"],["trends","📈 Trends"],["shape","🎯 Shape"],["gap","📐 Gap"],["compare","⚖️ Compare"],["history","🗂 History"]].map(([id,label])=>(
            <button key={id} onClick={()=>setTab(id)} style={tabBtn(tab===id)}>{label}</button>
          ))}
        </div>
      </div>

      <div style={{ padding:"14px 12px 40px" }}>

        {/* Club Selector */}
        <div style={{ display:"flex", gap:7, overflowX:"auto", paddingBottom:8, marginBottom:14, scrollbarWidth:"none" }}>
          {CLUBS.map(cl=>(
            <button key={cl} onClick={()=>setClub(cl)} style={pill(club===cl, CLUB_COLORS[cl])}>{cl}</button>
          ))}
        </div>

        {/* ════════════ LOG ════════════ */}
        {tab==="log" && (
          <>
            <div style={{ display:"flex", gap:8, marginBottom:14 }}>
              <button onClick={()=>setLogView("add")} style={subTab(logView==="add")}>➕ Add Shots</button>
              <button onClick={()=>setLogView("shots")} style={subTab(logView==="shots")}>📋 View ({allShots.length})</button>
            </div>

            {logView==="add" && (
              <div style={card}>
                <div style={{ fontWeight:800, fontSize:17, color:cc, marginBottom:14 }}>Add {club} Shots</div>

                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:12 }}>
                  <div><label style={lbl}>Date</label><input type="date" value={date} onChange={e=>setDate(e.target.value)} style={inp}/></div>
                  <div><label style={lbl}>Session</label><input value={sessName} onChange={e=>setSessName(e.target.value)} placeholder="Morning range" style={inp}/></div>
                  <div><label style={lbl}>Weather</label><input value={weather} onChange={e=>setWeather(e.target.value)} placeholder="e.g. Calm, 72°F" style={inp}/></div>
                  <div><label style={lbl}>Notes</label><input value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Focusing on tempo…" style={inp}/></div>
                </div>

                <div style={{ display:"flex", gap:8, marginBottom:14 }}>
                  <button onClick={()=>setBulkMode(false)} style={subTab(!bulkMode)}>Single</button>
                  <button onClick={()=>setBulkMode(true)} style={subTab(bulkMode)}>Bulk Paste</button>
                </div>

                {!bulkMode ? (
                  <>
                    <div style={{ fontSize:11, fontWeight:700, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:10 }}>Values in yards and mph (as shown in TopTracer)</div>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                      {FIELDS.map(f=>(
                        <div key={f.key}>
                          <label style={lbl}>{f.label} <span style={{ color:"#ccc", fontWeight:400 }}>({f.unit})</span></label>
                          <input type="number" step="0.1" value={shot[f.key]} onChange={e=>setShot(p=>({...p,[f.key]:e.target.value}))} placeholder={f.required?"Required":"—"} style={{ ...inp, borderColor:f.required?cc:"#e0e3e8", borderWidth:f.required?2:1.5 }}/>
                        </div>
                      ))}
                      <div>
                        <label style={lbl}>Curve (m)</label>
                        <div style={{ display:"flex", gap:6 }}>
                          <select value={shot.curveDir} onChange={e=>setShot(p=>({...p,curveDir:e.target.value}))} style={{ ...inp, width:52, padding:"10px 5px" }}><option>L</option><option>R</option></select>
                          <input type="number" value={shot.curve} onChange={e=>setShot(p=>({...p,curve:e.target.value}))} placeholder="—" style={{ ...inp, flex:1 }}/>
                        </div>
                      </div>
                      <div>
                        <label style={lbl}>Offline (m)</label>
                        <div style={{ display:"flex", gap:6 }}>
                          <select value={shot.offlineDir} onChange={e=>setShot(p=>({...p,offlineDir:e.target.value}))} style={{ ...inp, width:52, padding:"10px 5px" }}><option>L</option><option>R</option></select>
                          <input type="number" value={shot.offline} onChange={e=>setShot(p=>({...p,offline:e.target.value}))} placeholder="—" style={{ ...inp, flex:1 }}/>
                        </div>
                      </div>
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:8, margin:"12px 0" }}>
                      <input type="checkbox" id="mf" checked={shot.mishitOverride===true} onChange={e=>setShot(p=>({...p,mishitOverride:e.target.checked?true:null}))} style={{ width:18, height:18, accentColor:"#c0392b" }}/>
                      <label htmlFor="mf" style={{ fontSize:13, color:"#666", cursor:"pointer" }}>Flag as mishit <span style={{ color:"#ccc" }}>(auto-detected if unchecked)</span></label>
                    </div>
                    <button onClick={addSingle} style={{ width:"100%", background:`linear-gradient(135deg,${cc},${cc}cc)`, color:"#fff", border:"none", borderRadius:12, padding:"14px", fontFamily:"inherit", fontSize:17, fontWeight:800, cursor:"pointer", boxShadow:`0 4px 14px ${cc}44` }}>
                      + Add Shot
                    </button>
                  </>
                ) : (
                  <>
                    <div style={{ background:"#f0f9f0", border:"1px solid #b8e0b8", borderRadius:10, padding:12, marginBottom:10, fontSize:12, color:"#2e7d32", lineHeight:1.7 }}>
                      <strong>One shot per line.</strong> Columns:<br/>FlatCarry(yd) · DistTrend(yd) · BallSpeed(mph) · LaunchAngle(°) · Height(ft) · LandingAngle(°) · HangTime(s) · Curve(yd) · Offline(yd)<br/>
                      <code style={{ background:"#e0f4e0", padding:"2px 6px", borderRadius:4, fontSize:11 }}>127 129 97 27 85 46 5.5 L9 L25</code>
                    </div>
                    <textarea value={bulk} onChange={e=>setBulk(e.target.value)} rows={6} placeholder={"127 129 97 27 85 46 5.5 L9 L25\n126 131 94 20 62 39 4.8 L8 L24"} style={{ ...inp, resize:"vertical", lineHeight:1.9, fontFamily:"monospace", fontSize:13 }}/>
                    <button onClick={addBulk} style={{ width:"100%", marginTop:10, background:`linear-gradient(135deg,${cc},${cc}cc)`, color:"#fff", border:"none", borderRadius:12, padding:"14px", fontFamily:"inherit", fontSize:16, fontWeight:800, cursor:"pointer" }}>Add All Shots</button>
                  </>
                )}
              </div>
            )}

            {logView==="shots" && (
              <div style={card}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                  <div style={{ fontWeight:800, fontSize:16, color:cc }}>{club} · {allShots.length} shots</div>
                  <button onClick={()=>setMishitsOnly(p=>!p)} style={{ background:mishitsOnly?"#fdecea":"#f0f0f0", color:mishitsOnly?"#c0392b":"#666", border:"none", borderRadius:8, padding:"5px 12px", fontSize:12, fontWeight:700, fontFamily:"inherit", cursor:"pointer" }}>
                    {mishitsOnly?"All shots":`⚑ Mishits (${mishitRate}%)`}
                  </button>
                </div>

                {allShots.length===0 ? (
                  <div style={{ textAlign:"center", padding:"32px 0", color:"#ccc" }}>
                    <div style={{ fontSize:36, marginBottom:8 }}>🏌️</div>
                    <div>No {club} shots yet</div>
                  </div>
                ) : (
                  <>
                    {/* Personal Bests + Streak */}
                    {(personalBests.carry||personalBests.streak>0) && (
                      <div style={{ background:cb, border:`1px solid ${cc}33`, borderRadius:10, padding:12, marginBottom:12 }}>
                        <div style={{ fontSize:11, fontWeight:700, color:cc, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:8 }}>Personal Bests</div>
                        <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8 }}>
                          {personalBests.carry && statBox(`${personalBests.carry}yd`, "BEST CARRY", "#2e7d32")}
                          {personalBests.ballSpeed && statBox(`${personalBests.ballSpeed}mph`, "BEST SPEED", "#1565c0")}
                          {statBox(personalBests.streak, "BEST STREAK", cc)}
                        </div>
                        {streaks.current > 1 && (
                          <div style={{ marginTop:8, fontSize:12, color:cc, fontWeight:700, textAlign:"center" }}>
                            🔥 {streaks.current} solid shots in a row!
                          </div>
                        )}
                      </div>
                    )}

                    {sStats.flatCarry && (
                      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:6, marginBottom:12 }}>
                        {[
                          ["AVG", `${Math.round(sStats.flatCarry.avg)}`, cc],
                          ["BEST", `${Math.round(sStats.flatCarry.best)}`, "#2e7d32"],
                          ["±", `${Math.round(sStats.flatCarry.std)}`, "#7b3fa0"],
                          ["MISS", `${mishitRate}%`, "#c0392b"],
                        ].map(([l,v,col])=>statBox(v,l,col))}
                      </div>
                    )}

                    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                      {displayShots.slice().reverse().map(sh=>(
                        <div key={sh.id} style={{ background:sh.mishit?"#fff5f5":"#fafffe", border:`1.5px solid ${sh.mishit?"#ffcdd2":"#c8e6c9"}`, borderRadius:10, padding:"10px 12px" }}>
                          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
                            <span style={{ fontWeight:800, fontSize:22, color:sh.mishit?"#c0392b":cc, fontFamily:"monospace" }}>
                              {Math.round(sh.flatCarry)}<span style={{ fontSize:12, color:"#aaa", fontWeight:600 }}>yd</span>
                            </span>
                            <div style={{ display:"flex", gap:5, alignItems:"center" }}>
                              {sh.mishit && <span style={{ fontSize:10, fontWeight:700, background:"#fdecea", color:"#c0392b", borderRadius:4, padding:"2px 6px" }}>MISHIT</span>}
                              <button onClick={()=>toggleMishit(sh.sessId,club,sh.id)} style={{ background:sh.mishit?"#e8f5e9":"#fdecea", border:"none", color:sh.mishit?"#2e7d32":"#c0392b", borderRadius:5, padding:"3px 8px", fontSize:11, fontWeight:700, fontFamily:"inherit", cursor:"pointer" }}>
                                {sh.mishit?"✓ solid":"⚑ flag"}
                              </button>
                              <button onClick={()=>deleteShot(sh.sessId,club,sh.id)} style={{ background:"none", border:"none", color:"#ddd", cursor:"pointer", fontSize:16 }}>✕</button>
                            </div>
                          </div>
                          <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
                            {sh.ballSpeed!=null&&<span style={{ background:"#e3f2fd", color:"#1a5fa8", borderRadius:4, padding:"2px 7px", fontSize:11, fontWeight:600 }}>{sh.ballSpeed}mph</span>}
                            {sh.launchAngle!=null&&<span style={{ background:"#edf7ef", color:"#2d7a3a", borderRadius:4, padding:"2px 7px", fontSize:11, fontWeight:600 }}>{sh.launchAngle}° LA</span>}
                            {sh.height!=null&&<span style={{ background:"#f5edfb", color:"#7b3fa0", borderRadius:4, padding:"2px 7px", fontSize:11, fontWeight:600 }}>{sh.height}m H</span>}
                            {sh.offline!=null&&<span style={{ background:"#fff8e6", color:"#c05c1a", borderRadius:4, padding:"2px 7px", fontSize:11, fontWeight:600 }}>{sh.offlineDir}{sh.offline}yd off</span>}
                            {sh.hangTime!=null&&<span style={{ background:"#f0f3f7", color:"#4a6070", borderRadius:4, padding:"2px 7px", fontSize:11, fontWeight:600 }}>{sh.hangTime}s</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}

        {/* ════════════ STATS ════════════ */}
        {tab==="stats" && (
          <>
            <div style={card}>
              <div style={{ fontWeight:800, fontSize:16, color:cc, marginBottom:14 }}>
                {club} · Solid Shots <span style={{ fontSize:13, color:"#aaa", fontWeight:400 }}>({solid.length})</span>
              </div>
              {solid.length===0 ? <div style={{ color:"#ccc", textAlign:"center", padding:24 }}>No data yet for {club}</div> : (
                <>
                  <table style={{ width:"100%", borderCollapse:"collapse", fontSize:14 }}>
                    <thead>
                      <tr style={{ borderBottom:"2px solid #f0f0f0" }}>
                        {["","Avg","Best","Worst","±"].map((h,i)=>(
                          <th key={i} style={{ textAlign:i===0?"left":"right", padding:"5px 6px", fontSize:10, fontWeight:700, color:"#bbb", textTransform:"uppercase" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { label:"Carry", key:"flatCarry", fmt:v=>`${Math.round(v)}yd`, color:cc },
                        { label:"Ball Spd", key:"ballSpeed", fmt:v=>`${v}mph`, color:"#1a5fa8" },
                        { label:"Launch", key:"launchAngle", fmt:v=>`${v}°`, color:"#2d7a3a" },
                        { label:"Height", key:"height", fmt:v=>`${v}ft`, color:"#7b3fa0" },
                        { label:"Landing", key:"landingAngle", fmt:v=>`${v}°`, color:"#1a8a7a" },
                        { label:"Hang", key:"hangTime", fmt:v=>`${v}s`, color:"#4a6070" },
                      ].map(({label,key,fmt,color})=>{
                        const s=sStats[key]; if(!s) return null;
                        return (
                          <tr key={key} style={{ borderBottom:"1px solid #f5f5f5" }}>
                            <td style={{ padding:"9px 6px", fontWeight:700, color, fontSize:13 }}>{label}</td>
                            <td style={{ padding:"9px 6px", textAlign:"right", fontWeight:800, fontFamily:"monospace", fontSize:15 }}>{fmt(s.avg)}</td>
                            <td style={{ padding:"9px 6px", textAlign:"right", color:"#2d7a3a", fontFamily:"monospace", fontWeight:600, fontSize:13 }}>{fmt(s.best)}</td>
                            <td style={{ padding:"9px 6px", textAlign:"right", color:"#c0392b", fontFamily:"monospace", fontWeight:600, fontSize:13 }}>{fmt(s.worst)}</td>
                            <td style={{ padding:"9px 6px", textAlign:"right", color:"#bbb", fontFamily:"monospace", fontSize:13 }}>±{key==="flatCarry"?Math.round(s.std):s.std}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  {/* Carry efficiency */}
                  {sStats.flatCarry && sStats.ballSpeed && (
                    <div style={{ marginTop:14, background:"#f7f8fa", borderRadius:10, padding:12 }}>
                      <div style={{ fontSize:11, fontWeight:700, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:6 }}>Carry Efficiency</div>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                        <div>
                          <span style={{ fontSize:24, fontWeight:800, color:cc, fontFamily:"monospace" }}>
                            {(Math.round(sStats.flatCarry.avg)/sStats.ballSpeed.avg).toFixed(1)}
                          </span>
                          <span style={{ fontSize:12, color:"#aaa", marginLeft:4 }}>yd per mph</span>
                        </div>
                        <div style={{ fontSize:12, color:"#888", textAlign:"right" }}>
                          Higher = better<br/>launch conditions
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Optimal Launch */}
                  {idealLA && sStats.launchAngle && (
                    <div style={{ marginTop:10, background: sStats.launchAngle.avg >= idealLA-2 && sStats.launchAngle.avg <= idealLA+3 ? "#f0f9f0" : "#fff8f0", border:`1px solid ${sStats.launchAngle.avg >= idealLA-2 && sStats.launchAngle.avg <= idealLA+3 ? "#b8e0b8":"#ffe0b2"}`, borderRadius:10, padding:12 }}>
                      <div style={{ fontSize:11, fontWeight:700, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:8 }}>Launch Angle Analysis</div>
                      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                        <div style={{ textAlign:"center" }}>
                          <div style={{ fontSize:22, fontWeight:800, color:cc, fontFamily:"monospace" }}>{sStats.launchAngle.avg}°</div>
                          <div style={{ fontSize:10, color:"#aaa", fontWeight:700 }}>YOUR AVG</div>
                        </div>
                        <div style={{ textAlign:"center" }}>
                          <div style={{ fontSize:22, fontWeight:800, color:"#2d7a3a", fontFamily:"monospace" }}>{idealLA}°</div>
                          <div style={{ fontSize:10, color:"#aaa", fontWeight:700 }}>OPTIMAL</div>
                        </div>
                        <div style={{ textAlign:"center" }}>
                          <div style={{ fontSize:22, fontWeight:800, color: Math.abs(sStats.launchAngle.avg-idealLA)<=2?"#2d7a3a":"#c05c1a", fontFamily:"monospace" }}>
                            {sStats.launchAngle.avg>idealLA?"+":""}{(sStats.launchAngle.avg-idealLA).toFixed(1)}°
                          </div>
                          <div style={{ fontSize:10, color:"#aaa", fontWeight:700 }}>DIFF</div>
                        </div>
                      </div>
                      <div style={{ fontSize:12, color:"#666", lineHeight:1.5 }}>
                        {Math.abs(sStats.launchAngle.avg-idealLA)<=2
                          ? "✅ Your launch angle is in the optimal range for your ball speed."
                          : sStats.launchAngle.avg < idealLA
                          ? `⬆️ Launching ${(idealLA-sStats.launchAngle.avg).toFixed(1)}° too low — you may be leaving yards on the table.`
                          : `⬇️ Launching ${(sStats.launchAngle.avg-idealLA).toFixed(1)}° too high — could reduce carry efficiency.`}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Mishit Analysis */}
            <div style={{ ...card, border:"1.5px solid #ffcdd2" }}>
              <div style={{ fontWeight:800, fontSize:16, color:"#c0392b", marginBottom:14 }}>
                Mishit Analysis <span style={{ fontSize:13, color:"#e57373", fontWeight:400 }}>({mishits.length} · {mishitRate}%)</span>
              </div>
              {mishits.length===0 ? (
                <div style={{ textAlign:"center", padding:"20px 0", color:"#ccc" }}>
                  <div style={{ fontSize:28 }}>✅</div><div style={{ marginTop:6 }}>No mishits flagged</div>
                </div>
              ) : (
                <>
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginBottom:14 }}>
                    {[["Avg Carry",mStats.flatCarry?`${Math.round(mStats.flatCarry.avg)}yd`:"—"],["Ball Spd",mStats.ballSpeed?`${mStats.ballSpeed.avg}mph`:"—"],["Launch",mStats.launchAngle?`${mStats.launchAngle.avg}°`:"—"]].map(([l,v])=>(
                      <div key={l} style={{ background:"#fff5f5", border:"1px solid #ffcdd2", borderRadius:8, padding:"10px 6px", textAlign:"center" }}>
                        <div style={{ fontSize:16, fontWeight:800, color:"#c0392b", fontFamily:"monospace" }}>{v}</div>
                        <div style={{ fontSize:10, color:"#e57373", fontWeight:600, marginTop:2 }}>{l}</div>
                      </div>
                    ))}
                  </div>
                  {sStats.flatCarry && mStats.flatCarry && (
                    <div style={{ background:"#fff5f5", border:"1px solid #ffcdd2", borderRadius:10, padding:14, marginBottom:12 }}>
                      <div style={{ fontSize:11, fontWeight:700, color:"#e57373", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:4 }}>Distance Lost on Mishits</div>
                      <div style={{ fontSize:28, fontWeight:800, color:"#c0392b", fontFamily:"monospace" }}>−{Math.round(sStats.flatCarry.avg-mStats.flatCarry.avg)} yd</div>
                      <div style={{ fontSize:12, color:"#aaa", marginTop:2 }}>{Math.round(mStats.flatCarry.avg)}yd mishit avg vs {Math.round(sStats.flatCarry.avg)}yd solid avg</div>
                    </div>
                  )}
                  {mishits.some(s=>s.offline!=null) && (
                    <div>
                      <div style={{ fontSize:11, fontWeight:700, color:"#aaa", textTransform:"uppercase", marginBottom:8 }}>Offline Direction</div>
                      <div style={{ display:"flex", gap:8 }}>
                        {["L","R"].map(dir=>{
                          const rel=mishits.filter(s=>s.offlineDir===dir&&s.offline!=null);
                          const avg=rel.length?Math.round(rel.reduce((a,b)=>a+b.offline,0)/rel.length):0;
                          return (
                            <div key={dir} style={{ flex:1, background:dir==="L"?"#e3f2fd":"#fbe9e7", border:`1px solid ${dir==="L"?"#90caf9":"#ffab91"}`, borderRadius:8, padding:"10px", textAlign:"center" }}>
                              <div style={{ fontSize:20, fontWeight:800, color:dir==="L"?"#1a5fa8":"#c05c1a" }}>{dir}</div>
                              <div style={{ fontSize:14, fontWeight:700 }}>{rel.length} shots</div>
                              {avg>0&&<div style={{ fontSize:11, color:"#888" }}>avg {avg}yd off</div>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {/* ════════════ TRENDS ════════════ */}
        {tab==="trends" && (
          <>
            {trendData.length<2 ? (
              <div style={{ ...card, textAlign:"center", padding:48, color:"#ccc" }}>
                <div style={{ fontSize:36, marginBottom:10 }}>📈</div>
                <div>Log {club} shots across 2+ sessions to see trends</div>
              </div>
            ) : (
              <>
                <div style={card}>
                  <div style={{ fontWeight:700, fontSize:14, color:cc, marginBottom:12 }}>{club} — Carry Distance (yards)</div>
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={trendData} margin={{ top:5, right:16, bottom:5, left:-10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0"/>
                      <XAxis dataKey="label" tick={{ fill:"#aaa", fontSize:11 }}/>
                      <YAxis tick={{ fill:"#aaa", fontSize:11 }} domain={["auto","auto"]}/>
                      <Tooltip contentStyle={{ background:"#fff", border:"1px solid #eee", borderRadius:8, fontSize:13 }} formatter={(v,n)=>[v?`${v} yd`:"—",n]}/>
                      <Line type="monotone" dataKey="avgCarry" stroke={cc} strokeWidth={3} dot={{ fill:cc, r:5, stroke:"#fff", strokeWidth:2 }} name="Avg Carry"/>
                      <Line type="monotone" dataKey="bestCarry" stroke={`${cc}77`} strokeWidth={2} strokeDasharray="5 4" dot={false} name="Best"/>
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ ...card, border:"1.5px solid #ffcdd2" }}>
                  <div style={{ fontWeight:700, fontSize:14, color:"#c0392b", marginBottom:12 }}>{club} — Mishit Rate</div>
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={trendData} margin={{ top:5, right:16, bottom:5, left:-10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#fff0f0"/>
                      <XAxis dataKey="label" tick={{ fill:"#aaa", fontSize:11 }}/>
                      <YAxis tick={{ fill:"#aaa", fontSize:11 }} domain={[0,100]} unit="%"/>
                      <Tooltip contentStyle={{ background:"#fff", border:"1px solid #ffcdd2", borderRadius:8, fontSize:13 }} formatter={v=>[`${v}%`,"Mishit Rate"]}/>
                      <ReferenceLine y={15} stroke="#ffcdd2" strokeDasharray="5 3" label={{ value:"15%", fill:"#e57373", fontSize:10 }}/>
                      <Line type="monotone" dataKey="mishitPct" stroke="#c0392b" strokeWidth={2.5} dot={{ fill:"#c0392b", r:4 }} name="Mishit %"/>
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                {trendData.some(d=>d.avgBallSpeed) && (
                  <div style={card}>
                    <div style={{ fontWeight:700, fontSize:14, color:"#1a5fa8", marginBottom:12 }}>{club} — Ball Speed (mph)</div>
                    <ResponsiveContainer width="100%" height={180}>
                      <LineChart data={trendData} margin={{ top:5, right:16, bottom:5, left:-10 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f4ff"/>
                        <XAxis dataKey="label" tick={{ fill:"#aaa", fontSize:11 }}/>
                        <YAxis tick={{ fill:"#aaa", fontSize:11 }} domain={["auto","auto"]}/>
                        <Tooltip contentStyle={{ background:"#fff", border:"1px solid #eee", borderRadius:8, fontSize:13 }} formatter={v=>[`${v} mph`,"Ball Speed"]}/>
                        <Line type="monotone" dataKey="avgBallSpeed" stroke="#1a5fa8" strokeWidth={2.5} dot={{ fill:"#1a5fa8", r:4 }} name="Ball Speed"/>
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
                <div style={card}>
                  <div style={{ fontWeight:700, fontSize:14, color:cc, marginBottom:12 }}>{club} — Shot Dispersion</div>
                  <ResponsiveContainer width="100%" height={210}>
                    <ScatterChart margin={{ top:5, right:16, bottom:5, left:-10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0"/>
                      <XAxis dataKey="x" name="Shot #" tick={{ fill:"#aaa", fontSize:11 }}/>
                      <YAxis dataKey="y" name="Yards" tick={{ fill:"#aaa", fontSize:11 }} domain={["auto","auto"]}/>
                      <Tooltip contentStyle={{ background:"#fff", border:"1px solid #eee", borderRadius:8, fontSize:13 }} formatter={(v,n)=>[`${v} yd`,n]}/>
                      {sStats.flatCarry&&<ReferenceLine y={Math.round(sStats.flatCarry.avg)} stroke={cc} strokeDasharray="5 3" label={{ value:`${Math.round(sStats.flatCarry.avg)}yd`, fill:cc, fontSize:11 }}/>}
                      <Scatter name="Solid" data={solid.map((s,i)=>({ x:i+1, y:Math.round(s.flatCarry) }))} fill={cc} opacity={0.9} r={5}/>
                      <Scatter name="Mishit" data={mishits.map((s,i)=>({ x:solid.length+i+1, y:Math.round(s.flatCarry) }))} fill="#c0392b" opacity={0.9} r={5}/>
                    </ScatterChart>
                  </ResponsiveContainer>
                  <div style={{ display:"flex", gap:14, fontSize:11, color:"#aaa", marginTop:6 }}>
                    <span><span style={{ color:cc }}>●</span> Solid</span>
                    <span><span style={{ color:"#c0392b" }}>●</span> Mishit</span>
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {/* ════════════ SHOT SHAPE MAP ════════════ */}
        {tab==="shape" && (
          <div style={card}>
            <div style={{ fontWeight:800, fontSize:16, color:cc, marginBottom:6 }}>{club} — Shot Shape Map</div>
            <div style={{ fontSize:12, color:"#aaa", marginBottom:14 }}>Top-down view · offline from center line</div>
            {shapeData.length===0 ? (
              <div style={{ textAlign:"center", padding:"40px 0", color:"#ccc" }}>
                <div style={{ fontSize:36, marginBottom:8 }}>🎯</div>
                <div>No {club} shots with offline data yet</div>
              </div>
            ) : (
              <>
                <div style={{ position:"relative", background:"#f7fbf7", border:"1px solid #e0eee0", borderRadius:12, overflow:"hidden", height:320 }}>
                  {/* Fairway / target zone */}
                  <div style={{ position:"absolute", left:"50%", top:0, bottom:0, width:60, transform:"translateX(-50%)", background:"rgba(46,122,58,0.08)", borderLeft:"1px dashed #c8e6c9", borderRight:"1px dashed #c8e6c9" }}/>
                  {/* Center line */}
                  <div style={{ position:"absolute", left:"50%", top:0, bottom:0, width:1, background:"#c8e6c9" }}/>
                  {/* L / R labels */}
                  <div style={{ position:"absolute", top:8, left:12, fontSize:11, fontWeight:700, color:"#1a5fa8" }}>◀ L</div>
                  <div style={{ position:"absolute", top:8, right:12, fontSize:11, fontWeight:700, color:"#c05c1a" }}>R ▶</div>
                  <div style={{ position:"absolute", bottom:8, left:"50%", transform:"translateX(-50%)", fontSize:10, color:"#aaa" }}>Target Line</div>

                  {/* Plot shots */}
                  {(() => {
                    const maxOff = Math.max(20, ...shapeData.filter(s=>s.x!=null).map(s=>Math.abs(s.x)));
                    const maxCarry = Math.max(...shapeData.filter(s=>s.y).map(s=>s.y));
                    const minCarry = Math.min(...shapeData.filter(s=>s.y).map(s=>s.y));
                    const range = maxCarry - minCarry || 1;
                    return shapeData.filter(s=>s.y).map((sh,i)=>{
                      const px = 50 + (sh.x / maxOff) * 45; // % from left
                      const py = 5 + ((maxCarry - sh.y) / range) * 88; // % from top
                      return (
                        <div key={i} title={`${sh.y}yd · ${sh.x>=0?"R":"L"}${Math.abs(sh.x)}m off`} style={{
                          position:"absolute", left:`${px}%`, top:`${py}%`,
                          width:10, height:10, borderRadius:"50%",
                          background:sh.mishit?"#c0392b":cc,
                          transform:"translate(-50%,-50%)",
                          opacity:0.85, cursor:"pointer",
                          boxShadow:`0 1px 4px ${sh.mishit?"#c0392b":cc}66`,
                          border:"1.5px solid #fff",
                        }}/>
                      );
                    });
                  })()}
                </div>
                <div style={{ display:"flex", gap:14, fontSize:11, color:"#aaa", marginTop:8 }}>
                  <span><span style={{ color:cc }}>●</span> Solid · higher = longer</span>
                  <span><span style={{ color:"#c0392b" }}>●</span> Mishit</span>
                </div>

                {/* Shot shape summary */}
                {allShots.some(s=>s.offline!=null) && (
                  <div style={{ marginTop:14, display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
                    {[
                      ["Left", allShots.filter(s=>s.offlineDir==="L"&&s.offline!=null).length, "#1a5fa8"],
                      ["Straight", allShots.filter(s=>s.offline!=null&&s.offline<=3).length, "#2d7a3a"],
                      ["Right", allShots.filter(s=>s.offlineDir==="R"&&s.offline!=null).length, "#c05c1a"],
                    ].map(([l,v,col])=>(
                      <div key={l} style={{ background:"#f7f8fa", borderRadius:8, padding:"10px 6px", textAlign:"center" }}>
                        <div style={{ fontSize:20, fontWeight:800, color:col }}>{v}</div>
                        <div style={{ fontSize:11, color:"#aaa", fontWeight:600 }}>{l}</div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ════════════ CLUB GAPPING ════════════ */}
        {tab==="gap" && (
          <div style={card}>
            <div style={{ fontWeight:800, fontSize:16, color:"#1a2e22", marginBottom:6 }}>Club Gapping</div>
            <div style={{ fontSize:12, color:"#aaa", marginBottom:14 }}>Average solid carry per club (yards)</div>
            {gapData.length<2 ? (
              <div style={{ textAlign:"center", padding:"40px 0", color:"#ccc" }}>
                <div style={{ fontSize:36, marginBottom:8 }}>📐</div>
                <div>Log shots for at least 2 clubs to see gapping</div>
              </div>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={gapData} margin={{ top:5, right:10, bottom:5, left:-10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0"/>
                    <XAxis dataKey="club" tick={{ fill:"#555", fontSize:12, fontWeight:700 }}/>
                    <YAxis tick={{ fill:"#aaa", fontSize:11 }} domain={["auto","auto"]}/>
                    <Tooltip contentStyle={{ background:"#fff", border:"1px solid #eee", borderRadius:8, fontSize:13 }} formatter={v=>[`${v} yd`,"Avg Carry"]}/>
                    <Bar dataKey="avg" radius={[6,6,0,0]}>
                      {gapData.map((d,i)=><Cell key={i} fill={d.color}/>)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>

                <div style={{ marginTop:14, display:"flex", flexDirection:"column", gap:6 }}>
                  {gapData.map((d,i)=>{
                    const next=gapData[i+1];
                    const gap=next?d.avg-next.avg:null;
                    return (
                      <div key={d.club} style={{ display:"flex", alignItems:"center", gap:10, background:"#f7f8fa", borderRadius:8, padding:"10px 12px" }}>
                        <span style={{ fontWeight:800, color:d.color, minWidth:48, fontSize:14 }}>{d.club}</span>
                        <span style={{ fontWeight:800, fontFamily:"monospace", fontSize:18, color:"#111" }}>{d.avg}yd</span>
                        <span style={{ fontSize:11, color:"#aaa" }}>{d.count} shots</span>
                        {gap!=null&&<span style={{ marginLeft:"auto", fontSize:12, fontWeight:700, color:gap<10||gap>25?"#c0392b":"#2d7a3a", background:gap<10||gap>25?"#fdecea":"#edf7ef", borderRadius:5, padding:"2px 8px" }}>
                          ↓{gap}yd to {next.club}
                        </span>}
                      </div>
                    );
                  })}
                </div>
                <div style={{ marginTop:12, fontSize:12, color:"#aaa", lineHeight:1.6 }}>
                  💡 Ideal gaps are 10–20 yards between clubs. Red gaps may indicate a distance hole in your bag.
                </div>
              </>
            )}
          </div>
        )}

        {/* ════════════ COMPARE ════════════ */}
        {tab==="compare" && (
          <>
            <div style={card}>
              <div style={{ fontWeight:800, fontSize:16, color:cc, marginBottom:14 }}>Compare Sessions · {club}</div>
              {sessions.filter(s=>s.shots[club]?.length>0).length<2 ? (
                <div style={{ textAlign:"center", padding:"30px 0", color:"#ccc" }}>
                  <div style={{ fontSize:32, marginBottom:8 }}>⚖️</div>
                  <div>Need at least 2 sessions with {club} shots</div>
                </div>
              ) : (
                <>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:16 }}>
                    {[["Session A", compareA, setCompareA], ["Session B", compareB, setCompareB]].map(([label, val, setter])=>(
                      <div key={label}>
                        <label style={lbl}>{label}</label>
                        <select value={val||""} onChange={e=>setter(Number(e.target.value)||null)} style={inp}>
                          <option value="">Select…</option>
                          {sessions.filter(s=>s.shots[club]?.length>0).map(s=>(
                            <option key={s.id} value={s.id}>{s.label} ({s.date})</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>

                  {compareSessions && (
                    <div>
                      {[
                        { label:"Avg Carry", aVal:compareSessions.a.carry?`${Math.round(compareSessions.a.carry.avg)}yd`:"—", bVal:compareSessions.b.carry?`${Math.round(compareSessions.b.carry.avg)}yd`:"—", aRaw:compareSessions.a.carry?.avg, bRaw:compareSessions.b.carry?.avg, higherIsBetter:true },
                        { label:"Best Carry", aVal:compareSessions.a.carry?`${Math.round(compareSessions.a.carry.best)}yd`:"—", bVal:compareSessions.b.carry?`${Math.round(compareSessions.b.carry.best)}yd`:"—", aRaw:compareSessions.a.carry?.best, bRaw:compareSessions.b.carry?.best, higherIsBetter:true },
                        { label:"Consistency ±", aVal:compareSessions.a.carry?`±${Math.round(compareSessions.a.carry.std)}yd`:"—", bVal:compareSessions.b.carry?`±${Math.round(compareSessions.b.carry.std)}yd`:"—", aRaw:compareSessions.a.carry?.std, bRaw:compareSessions.b.carry?.std, higherIsBetter:false },
                        { label:"Ball Speed", aVal:compareSessions.a.ballSpeed?`${compareSessions.a.ballSpeed.avg}mph`:"—", bVal:compareSessions.b.ballSpeed?`${compareSessions.b.ballSpeed.avg}mph`:"—", aRaw:compareSessions.a.ballSpeed?.avg, bRaw:compareSessions.b.ballSpeed?.avg, higherIsBetter:true },
                        { label:"Launch °", aVal:compareSessions.a.launchAngle?`${compareSessions.a.launchAngle.avg}°`:"—", bVal:compareSessions.b.launchAngle?`${compareSessions.b.launchAngle.avg}°`:"—", aRaw:null, bRaw:null },
                        { label:"Mishit Rate", aVal:`${compareSessions.a.mishitRate}%`, bVal:`${compareSessions.b.mishitRate}%`, aRaw:compareSessions.a.mishitRate, bRaw:compareSessions.b.mishitRate, higherIsBetter:false },
                      ].map(({label,aVal,bVal,aRaw,bRaw,higherIsBetter})=>{
                        const aWins = aRaw!=null&&bRaw!=null&&(higherIsBetter?aRaw>bRaw:aRaw<bRaw);
                        const bWins = aRaw!=null&&bRaw!=null&&(higherIsBetter?bRaw>aRaw:bRaw<aRaw);
                        return (
                          <div key={label} style={{ display:"grid", gridTemplateColumns:"1fr auto 1fr", gap:6, alignItems:"center", borderBottom:"1px solid #f5f5f5", padding:"10px 0" }}>
                            <div style={{ textAlign:"right", fontFamily:"monospace", fontSize:17, fontWeight:800, color:aWins?"#2d7a3a":bWins?"#c0392b":"#111" }}>{aVal}{aWins&&" ✓"}</div>
                            <div style={{ textAlign:"center", fontSize:11, fontWeight:700, color:"#aaa", minWidth:70 }}>{label}</div>
                            <div style={{ textAlign:"left", fontFamily:"monospace", fontSize:17, fontWeight:800, color:bWins?"#2d7a3a":aWins?"#c0392b":"#111" }}>{bWins&&"✓ "}{bVal}</div>
                          </div>
                        );
                      })}
                      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginTop:14 }}>
                        {[compareSessions.a, compareSessions.b].map((s,i)=>(
                          <div key={i} style={{ background:"#f7f8fa", borderRadius:8, padding:"8px 10px", textAlign:"center" }}>
                            <div style={{ fontSize:12, fontWeight:800, color:cc }}>{s.label}</div>
                            <div style={{ fontSize:11, color:"#aaa" }}>{s.date} · {s.count} shots</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {/* ════════════ HISTORY ════════════ */}
        {tab==="history" && (
          <>
            {sessions.length===0 ? (
              <div style={{ ...card, textAlign:"center", padding:48, color:"#ccc" }}>
                <div style={{ fontSize:36, marginBottom:10 }}>🗂</div>
                <div>No sessions yet</div>
              </div>
            ) : [...sessions].reverse().map(session=>{
              const all=Object.values(session.shots).flat();
              const ms=all.filter(s=>s.mishit).length;
              const isOpen=expandedSess===session.id;
              return (
                <div key={session.id} style={{ ...card, padding:0, overflow:"hidden" }}>
                  <div style={{ padding:"14px 16px", cursor:"pointer", background:isOpen?"#f7f8fa":"#fff" }} onClick={()=>setExpandedSess(isOpen?null:session.id)}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                      <div>
                        <div style={{ fontWeight:800, fontSize:15 }}>{session.label}</div>
                        <div style={{ fontSize:12, color:"#888", marginTop:2 }}>
                          {session.date} · {all.length} shots · <span style={{ color:"#c0392b" }}>{ms} mishits</span>
                          {session.weather&&<span style={{ color:"#aaa" }}> · {session.weather}</span>}
                        </div>
                        {session.notes&&<div style={{ fontSize:12, color:"#aaa", marginTop:2, fontStyle:"italic" }}>"{session.notes}"</div>}
                      </div>
                      <span style={{ color:"#ccc", fontSize:14, marginLeft:8 }}>{isOpen?"▲":"▼"}</span>
                    </div>
                    <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginTop:8 }}>
                      {Object.keys(session.shots).map(c=>(
                        <span key={c} style={{ fontSize:11, fontWeight:700, color:CLUB_COLORS[c], background:CLUB_LIGHT[c], borderRadius:5, padding:"2px 8px" }}>{c}</span>
                      ))}
                    </div>
                  </div>
                  {isOpen && (
                    <div style={{ padding:"4px 16px 16px", borderTop:"1px solid #f0f0f0" }}>
                      {CLUBS.filter(c=>session.shots[c]?.length>0).map(cl=>{
                        const shots=session.shots[cl];
                        const sol=shots.filter(s=>!s.mishit);
                        const avg=sol.length?Math.round(sol.reduce((a,b)=>a+(b.flatCarry||0),0)/sol.length):null;
                        return (
                          <div key={cl} style={{ marginTop:14 }}>
                            <div style={{ fontWeight:700, fontSize:13, color:CLUB_COLORS[cl], marginBottom:6 }}>
                              {cl} {avg&&<span style={{ color:"#aaa", fontWeight:400 }}>· avg {avg}yd · {shots.filter(s=>s.mishit).length} mishits</span>}
                            </div>
                            <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
                              {shots.map((sh,i)=>(
                                <span key={i} style={{ background:sh.mishit?"#fff5f5":CLUB_LIGHT[cl], border:`1.5px solid ${sh.mishit?"#ffcdd2":CLUB_COLORS[cl]+"44"}`, borderRadius:6, padding:"4px 10px", fontSize:13, fontWeight:700, fontFamily:"monospace", color:sh.mishit?"#c0392b":CLUB_COLORS[cl] }}>
                                  {Math.round(sh.flatCarry)}{sh.mishit?"⚑":""}
                                </span>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
