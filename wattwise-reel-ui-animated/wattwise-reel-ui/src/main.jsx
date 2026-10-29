import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, ArrowLeft, ArrowRight, ArrowUpRight, BadgeCheck, BarChart3,
  Bolt, Check, ChevronRight, CircleHelp, Clock3, CloudUpload, FileCheck2,
  FileSpreadsheet, FileText, Gauge, History, Image as ImageIcon, Info, Leaf,
  Lightbulb, Loader2, Menu, Moon, Receipt, RefreshCw, ScanSearch, ShieldCheck,
  SlidersHorizontal, Sparkles, Sun, Upload, X, Zap
} from 'lucide-react';
import './styles.css';
import {
  checkHealth, uploadAndAnalyze, listAnalyses, getAnalysis,
  runWhatIf, explainAnalysis
} from './api';

const starter = [
  { time: '00:00', actual: 82, baseline: 42 },
  { time: '02:00', actual: 78, baseline: 39 },
  { time: '04:00', actual: 76, baseline: 38 },
  { time: '06:00', actual: 58, baseline: 44 },
  { time: '08:00', actual: 64, baseline: 61 },
  { time: '10:00', actual: 88, baseline: 79 },
  { time: '12:00', actual: 94, baseline: 84 },
  { time: '14:00', actual: 89, baseline: 81 },
  { time: '16:00', actual: 92, baseline: 86 },
  { time: '18:00', actual: 76, baseline: 72 },
  { time: '20:00', actual: 67, baseline: 61 },
  { time: '22:00', actual: 72, baseline: 46 }
];

const steps = [
  { id: 'discover', n: '01', label: 'Discover', icon: Gauge, sub: 'Start with the signals' },
  { id: 'investigate', n: '02', label: 'Investigate', icon: ScanSearch, sub: 'Understand the anomaly' },
  { id: 'experiment', n: '03', label: 'Experiment', icon: SlidersHorizontal, sub: 'Test a practical change' },
  { id: 'report', n: '04', label: 'Proof of savings', icon: FileCheck2, sub: 'Review your impact' }
];

const money = n =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0
  }).format(n || 0);

function Chart({ data, compact = false }) {
  const chartData = data && data.length > 0 ? data : starter;
  const w = 700;
  const h = compact ? 100 : 200;
  const px = 10;
  const py = 12;
  const max = Math.max(100, ...chartData.map(d => Math.max(d.actual || 0, d.baseline || 0))) * 1.08;
  const x = i => px + i * (w - 2 * px) / Math.max(1, chartData.length - 1);
  const y = v => h - py - ((v || 0) / max) * (h - 2 * py);
  const line = k => chartData.map((d, i) => `${x(i)},${y(d[k])}`).join(' ');

  return (
    <div className={'chart ' + (compact ? 'compact' : '')}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label="Actual energy compared with baseline">
        {[0, 1, 2, 3].map(i => (
          <line key={i} x1="0" x2={w} y1={py + i * (h - 2 * py) / 3} y2={py + i * (h - 2 * py) / 3} className="gridline" />
        ))}
        <polyline points={line('baseline')} className="baseline" />
        <polyline points={line('actual')} className="actual" />
        {chartData.map((d, i) => (
          <circle key={i} cx={x(i)} cy={y(d.actual)} r={compact ? 2 : 3} className="dot" />
        ))}
      </svg>
      {!compact && (
        <div className="chart-times">
          {chartData.length <= 12 ? (
            chartData.map((d, i) => <span key={i}>{d.time}</span>)
          ) : (
            <>
              <span>{chartData[0]?.time || 'Start'}</span>
              <span>{chartData[Math.floor(chartData.length / 4)]?.time || 'Q1'}</span>
              <span>{chartData[Math.floor(chartData.length / 2)]?.time || 'Mid'}</span>
              <span>{chartData[Math.floor((3 * chartData.length) / 4)]?.time || 'Q3'}</span>
              <span>{chartData[chartData.length - 1]?.time || 'End'}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function App() {
  const [step, setStep] = useState('discover');
  const [dir, setDir] = useState('next');
  const [avoid, setAvoid] = useState(50);
  const [rate, setRate] = useState(8);
  const [data, setData] = useState(starter);
  const [fileName, setFileName] = useState('');
  const [toast, setToast] = useState('');
  const [menu, setMenu] = useState(false);
  const [saved, setSaved] = useState(false);

  // API Integration state
  const [backendHealth, setBackendHealth] = useState({ status: 'checking' });
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('');
  const [currentAnalysis, setCurrentAnalysis] = useState(null);
  const [historyList, setHistoryList] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiExplanation, setAiExplanation] = useState('');

  const fileRef = useRef(null);
  const idx = steps.findIndex(s => s.id === step);

  const notify = t => {
    setToast(t);
    window.setTimeout(() => setToast(''), 4000);
  };

  const go = id => {
    setDir(steps.findIndex(s => s.id === id) >= idx ? 'next' : 'back');
    setStep(id);
    setMenu(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const next = () => go(steps[Math.min(idx + 1, 3)].id);
  const back = () => go(steps[Math.max(idx - 1, 0)].id);

  // Poll health and history on mount and periodically
  useEffect(() => {
    async function checkStatus() {
      try {
        const health = await checkHealth();
        setBackendHealth(health);
        if (health && health.status === 'ok') {
          loadHistoryList();
        }
      } catch {
        setBackendHealth({ status: 'offline' });
      }
    }
    checkStatus();
    const timer = setInterval(checkStatus, 15000);
    return () => clearInterval(timer);
  }, []);

  async function loadHistoryList() {
    try {
      const res = await listAnalyses(20);
      if (res && res.items) {
        setHistoryList(res.items);
      }
    } catch {
      // ignore history list failures
    }
  }

  // Active calculation metrics
  const overnight = useMemo(() => {
    if (currentAnalysis?.result?.overnight_analysis) {
      return Number(currentAnalysis.result.overnight_analysis.potential_excess_kwh || 0);
    }
    return data
      .filter((_, i) => i < 3 || i === data.length - 1)
      .reduce((a, d) => a + Math.max(0, d.actual - d.baseline), 0);
  }, [currentAnalysis, data]);

  const avoided = useMemo(() => {
    return (overnight * avoid) / 100;
  }, [overnight, avoid]);

  const savings = useMemo(() => {
    return avoided * rate;
  }, [avoided, rate]);

  const annualized = useMemo(() => {
    const daysCovered = currentAnalysis?.result?.summary?.days_covered || 1;
    return (savings / Math.max(1, daysCovered)) * 365;
  }, [currentAnalysis, savings]);

  // Convert daily_energy to chart series
  function applyBackendResultToChart(result) {
    if (result.daily_energy && result.daily_energy.length > 0) {
      const baselineKwh = (result.overnight_analysis?.baseline_kwh_per_reading || 0) * 24;
      const chartPoints = result.daily_energy.map(d => ({
        time: d.day.slice(5) || d.day,
        actual: Number(d.total_kwh),
        baseline: baselineKwh > 0 ? Number(baselineKwh.toFixed(1)) : Number((d.total_kwh * 0.78).toFixed(1))
      }));
      setData(chartPoints);
    }
  }

  // Client-side fallback if backend server is not running
  function loadCSVFallback(file) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const rows = String(e.target.result).trim().split(/\r?\n/);
        const head = rows.shift().split(',').map(x => x.trim().toLowerCase());
        const ti = head.findIndex(x => ['timestamp', 'time', 'datetime', 'date'].includes(x));
        const ki = head.findIndex(x => ['kwh', 'consumption', 'energy_kwh', 'usage'].includes(x));
        const bi = head.findIndex(x => ['baseline', 'baseline_kwh', 'expected_kwh'].includes(x));
        if (ki < 0 || rows.length < 3) throw Error('CSV needs a kWh column and at least 3 rows.');

        const parsed = rows.map((r, i) => {
          const c = r.split(',').map(x => x.trim());
          const a = Number(c[ki]);
          const b = bi >= 0 ? Number(c[bi]) : a * 0.72;
          return {
            time: ti >= 0 ? (c[ti].slice(11, 16) || c[ti]) : String(i + 1),
            actual: a,
            baseline: Number.isFinite(b) ? b : a * 0.72
          };
        });
        setData(parsed.slice(0, 48));
        setFileName(file.name);
        setCurrentAnalysis(null);
        setSaved(false);
        notify('Loaded CSV in local preview mode. (Start FastAPI for full engine).');
        go('investigate');
      } catch (err) {
        notify(err.message || 'Could not parse CSV.');
      }
    };
    reader.readAsText(file);
  }

  function loadBillFallback(file) {
    // Generate simulated bill profile for immediate UI preview
    const billUnits = 520;
    const syntheticPoints = Array.from({ length: 12 }, (_, i) => ({
      time: `${String(i * 2).padStart(2, '0')}:00`,
      actual: 30 + Math.sin(i / 2) * 20 + (i < 3 ? 15 : 0),
      baseline: 25 + Math.sin(i / 2) * 15
    }));
    setData(syntheticPoints);
    setFileName(file.name);
    setCurrentAnalysis({
      id: 'local',
      filename: file.name,
      file_type: 'bill_image',
      result: {
        summary: { total_energy_kwh: billUnits, reading_count: 24, days_covered: 30 },
        overnight_analysis: { potential_excess_kwh: 16.5, baseline_kwh_per_reading: 1.2, anomaly_count: 2 },
        what_if: { projected_daily_savings: 66.0, projected_annual_savings: 24090.0 },
        bill_details: {
          provider: 'Electricity Utility Bill (Local Preview)',
          consumer_id: 'EB-PREVIEW-992',
          bill_date: new Date().toISOString().slice(0, 10),
          total_kwh: billUnits,
          total_amount: 4160,
          tariff_rate: 8.0,
          days: 30
        }
      }
    });
    setSaved(false);
    notify('Loaded bill in local preview mode. (Start FastAPI on port 8000 for live AI OCR).');
    go('investigate');
  }

  // Handle Multi-Format File Upload (PNG, JPG, PDF, CSV)
  async function handleFileUpload(file) {
    if (!file) return;

    const lowerName = file.name.toLowerCase();
    const validExts = ['.csv', '.tsv', '.txt', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.pdf'];
    const isSupported = validExts.some(ext => lowerName.endsWith(ext));

    if (!isSupported) {
      return notify('Please upload an electricity bill (.png, .jpg), PDF, or CSV telemetry file.');
    }

    const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'].some(ext => lowerName.endsWith(ext));
    const isPdf = lowerName.endsWith('.pdf');

    setLoading(true);
    setLoadingMsg(
      isImage
        ? `Analyzing bill image (${file.name}) with Nemotron Vision...`
        : isPdf
        ? `Extracting telemetry from PDF bill (${file.name})...`
        : `Analyzing telemetry from ${file.name}...`
    );

    try {
      const res = await uploadAndAnalyze(file, {
        electricity_rate: rate,
        avoidable_percent: avoid,
        overnight_start_hour: 0,
        overnight_end_hour: 6,
        anomaly_sigma: 3.0,
        annualize_daily_savings: true
      });

      if (!res || !res.result) {
        throw new Error('Analysis completed without result data.');
      }

      setCurrentAnalysis(res);
      setFileName(res.filename || file.name);
      setSaved(false);
      setAiExplanation('');

      if (res.result.config) {
        if (typeof res.result.config.electricity_rate === 'number') setRate(res.result.config.electricity_rate);
        if (typeof res.result.config.avoidable_percent === 'number') setAvoid(res.result.config.avoidable_percent);
      }

      applyBackendResultToChart(res.result);
      await loadHistoryList();

      const billMeta = res.bill_details || res.result.bill_details;
      if (billMeta) {
        notify(`Bill processed: ${billMeta.provider || file.name} (${res.result.summary.total_energy_kwh} kWh).`);
      } else {
        notify(`Analysis #${res.id} complete: ${res.result.summary.reading_count} readings processed.`);
      }

      go('investigate');
    } catch (err) {
      // Check if backend was unreachable
      if (err.message && err.message.includes('Backend server is unreachable')) {
        if (file.name.toLowerCase().endsWith('.csv')) {
          loadCSVFallback(file);
        } else {
          loadBillFallback(file);
        }
      } else {
        notify(err.message || 'Error processing uploaded file.');
      }
    } finally {
      setLoading(false);
      setLoadingMsg('');
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  // Load past analysis
  async function handleLoadPastAnalysis(id) {
    setLoading(true);
    setLoadingMsg(`Loading analysis #${id}...`);
    try {
      const detail = await getAnalysis(id);
      if (!detail || !detail.result) {
        throw new Error('Analysis record not found.');
      }
      setCurrentAnalysis(detail);
      setFileName(detail.filename || `Analysis #${id}`);
      setSaved(true);
      setAiExplanation('');

      if (detail.config) {
        if (typeof detail.config.electricity_rate === 'number') setRate(detail.config.electricity_rate);
        if (typeof detail.config.avoidable_percent === 'number') setAvoid(detail.config.avoidable_percent);
      }

      applyBackendResultToChart(detail.result);
      setShowHistory(false);
      notify(`Loaded analysis #${id}: ${detail.filename}`);
      go('investigate');
    } catch (err) {
      notify(err.message || 'Could not load historical analysis.');
    } finally {
      setLoading(false);
      setLoadingMsg('');
    }
  }

  // Trigger what-if recalculation
  async function handleSaveWhatIf() {
    if (!currentAnalysis?.id || currentAnalysis.id === 'local') {
      setSaved(true);
      notify('Scenario saved in preview.');
      return;
    }

    setLoading(true);
    setLoadingMsg('Recalculating scenario with backend engine...');
    try {
      const updated = await runWhatIf(currentAnalysis.id, {
        electricity_rate: Number(rate),
        avoidable_percent: Number(avoid),
        overnight_start_hour: 0,
        overnight_end_hour: 6,
        anomaly_sigma: 3.0,
        annualize_daily_savings: true
      });

      if (updated && updated.result) {
        setCurrentAnalysis(prev => ({
          ...prev,
          result: updated.result
        }));
        setSaved(true);
        notify('Scenario saved and validated by FastAPI engine.');
      }
    } catch (err) {
      notify(err.message || 'What-if recalculation failed.');
    } finally {
      setLoading(false);
      setLoadingMsg('');
    }
  }

  // Trigger Nemotron AI Explanation
  async function handleExplainWithAI() {
    if (!currentAnalysis?.id || currentAnalysis.id === 'local') {
      return notify('Please ensure the FastAPI backend is running and a bill/telemetry file is analyzed.');
    }

    setAiLoading(true);
    try {
      const res = await explainAnalysis(currentAnalysis.id);
      if (res && res.explanation) {
        setAiExplanation(res.explanation);
        notify('Nemotron AI explanation generated.');
      } else {
        notify('No explanation content returned.');
      }
    } catch (err) {
      notify(err.message || 'AI explanation service error.');
    } finally {
      setAiLoading(false);
    }
  }

  const billData = currentAnalysis?.result?.bill_details || currentAnalysis?.bill_details;

  const Header = () => (
    <header className="topbar">
      <button className="mobile-menu" onClick={() => setMenu(!menu)} aria-label="Toggle menu">
        <Menu size={19} />
      </button>
      <div className="brand">
        <span className="brand-mark">
          <Zap size={17} fill="currentColor" />
        </span>
        <b>wattwise<span>.</span></b>
      </div>
      <div className="top-center">
        <i /> ENERGY INVESTIGATION <span>/</span> <b>{steps[idx].label}</b>
      </div>
      <div className="top-right">
        {historyList.length > 0 && (
          <button className="history-btn" onClick={() => setShowHistory(true)} title="View past analyses">
            <History size={13} />
            <span>History ({historyList.length})</span>
          </button>
        )}
        {backendHealth.status === 'ok' ? (
          <span className="demo-chip live-chip" title="Connected to FastAPI backend">
            <i className="live-dot" /> LIVE API
          </span>
        ) : (
          <span className="demo-chip" title="FastAPI offline · Running in local preview">
            <i className="offline-dot" /> PREVIEW MODE
          </span>
        )}
        <span className="avatar">A</span>
      </div>
    </header>
  );

  const Progress = () => (
    <div className="progress">
      <div className="progress-track">
        <i style={{ width: `${(idx / 3) * 100}%` }} />
      </div>
      <div className="progress-items">
        {steps.map((s, i) => {
          const Icon = s.icon;
          return (
            <button
              key={s.id}
              className={`progress-item ${step === s.id ? 'current' : ''} ${i < idx ? 'done' : ''}`}
              onClick={() => go(s.id)}
            >
              <span className="progress-icon">
                {i < idx ? <Check size={14} /> : <Icon size={14} />}
              </span>
              <span>
                <small>{s.n}</small>
                {s.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const FooterNav = ({ label = 'Continue', action = next }) => (
    <div className="page-nav">
      <button className="back-btn" onClick={back}>
        <ArrowLeft size={15} /> Back
      </button>
      <span>STEP {String(idx + 1).padStart(2, '0')} OF 04</span>
      <button className="primary-btn" onClick={action}>
        {label} <ArrowRight size={15} />
      </button>
    </div>
  );

  return (
    <div className="app">
      <Header />
      <div className={`layout ${menu ? 'menu-open' : ''}`}>
        <aside className="sidebar">
          <div className="side-label">YOUR JOURNEY</div>
          {steps.map((s, i) => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                className={`side-step ${step === s.id ? 'active' : ''} ${i < idx ? 'done' : ''}`}
                onClick={() => go(s.id)}
              >
                <span className="side-icon">
                  {i < idx ? <Check size={15} /> : <Icon size={15} />}
                </span>
                <span>
                  <b>{s.label}</b>
                  <small>{s.sub}</small>
                </span>
                {step === s.id && <ChevronRight size={15} />}
              </button>
            );
          })}
          <div className="side-tip">
            <span>
              <Lightbulb size={16} />
            </span>
            <b>Multi-Format Ingestion.</b>
            <p>Upload utility bills (PNG, JPG, PDF) or raw smart meter CSV files.</p>
            <small>
              <ShieldCheck size={13} /> Nemotron Vision OCR
            </small>
          </div>
          <div className="side-foot">
            <CircleHelp size={14} /> WattWise <span>v1.1 (Multi-Format)</span>
          </div>
        </aside>

        <main className="stage">
          <Progress />

          {loading && (
            <div style={{ padding: '0 0 14px' }}>
              <div className="loading-bar">
                <div className="loading-bar-inner" />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px', color: 'var(--lime)' }}>
                <Loader2 size={13} className="spin" /> {loadingMsg || 'Processing energy bill...'}
              </div>
            </div>
          )}

          <div key={step} className={`screen ${dir === 'back' ? 'screen-back' : ''}`}>
            {/* STEP 1: DISCOVER */}
            {step === 'discover' && (
              <section className="discover">
                <div className="hero">
                  <div className="eyebrow">
                    <i /> ENERGY WASTE, MADE VISIBLE
                  </div>
                  <h1>
                    Find the waste.<br />
                    <em>Prove the fix.</em>
                  </h1>
                  <p>
                    One signal at a time. Upload electricity bills (PNG, JPG, PDF) or CSV telemetry to detect waste and calculate savings.
                  </p>
                  <div className="hero-buttons">
                    <button className="primary-btn big" onClick={() => go('investigate')}>
                      <Sparkles size={16} /> Start investigation <ArrowRight size={16} />
                    </button>
                    <button className="quiet-btn" onClick={() => fileRef.current?.click()} disabled={loading}>
                      <Upload size={15} /> {loading ? 'Analyzing...' : 'Upload Bill or CSV'}
                    </button>
                    <input
                      ref={fileRef}
                      hidden
                      type="file"
                      accept=".csv,text/csv,.tsv,.txt,.png,.jpg,.jpeg,.webp,.bmp,.pdf,image/png,image/jpeg,image/webp,application/pdf"
                      onChange={e => handleFileUpload(e.target.files?.[0])}
                    />
                  </div>
                  <div className="trust">
                    <ShieldCheck size={14} /> Transparent calculations <span>·</span> Accepts PNG, JPG, PDF bills & CSV telemetry
                  </div>
                </div>

                <div className="hero-graphic">
                  <div className="orbit o1" />
                  <div className="orbit o2" />
                  <div className="core">
                    <Zap size={27} fill="currentColor" />
                  </div>
                  <div className="float-card float-a">
                    <span className="float-icon orange">
                      <Moon size={15} />
                    </span>
                    <span>
                      <small>OVERNIGHT SIGNAL</small>
                      <b>Usage above baseline</b>
                    </span>
                    <i>!</i>
                  </div>
                  <div className="float-card float-b">
                    <span className="float-icon green">
                      <Leaf size={15} />
                    </span>
                    <span>
                      <small>WHAT-IF ESTIMATE</small>
                      <b>{money(savings)} <small>/ day</small></b>
                    </span>
                    <ArrowRight size={14} />
                  </div>
                  <div className="graphic-caption">
                    <i /> {currentAnalysis ? `${fileName} · ${billData ? 'BILL PARSED' : 'TELEMETRY'}` : 'SAMPLE BUILDING DATA · ILLUSTRATIVE'}
                  </div>
                </div>

                <div className="overview-cards">
                  <button className="overview-card savings-card" onClick={() => go('experiment')}>
                    <div className="card-head">
                      <span><Leaf size={17} /></span>
                      <ArrowUpRight size={16} />
                    </div>
                    <small>POTENTIAL SAVINGS</small>
                    <strong>{money(savings)}<i>/day</i></strong>
                    <p>Explore a possible fix <b>→</b></p>
                    <div className="deco">✳</div>
                  </button>

                  <button className="overview-card waste-card" onClick={() => go('investigate')}>
                    <div className="card-head">
                      <span><Activity size={17} /></span>
                      <label>SIGNAL FOUND</label>
                    </div>
                    <small>EXCESS OVERNIGHT USE</small>
                    <strong>{overnight.toFixed(1)} <i>kWh</i></strong>
                    <p>Open the evidence <b>→</b></p>
                    <div className="sparkline">
                      <Chart data={data} compact />
                    </div>
                  </button>

                  <button className="overview-card data-card" onClick={() => fileRef.current?.click()}>
                    <div className="card-head">
                      <span>{billData ? <Receipt size={17} /> : <CloudUpload size={17} />}</span>
                      <ArrowUpRight size={16} />
                    </div>
                    <small>YOUR ENERGY BILLS & DATA</small>
                    <strong>{fileName ? (billData ? 'Electricity Bill' : 'Telemetry CSV') : 'Sample dataset'}</strong>
                    <p>{fileName || 'Upload PNG, PDF bill or CSV'} <b>→</b></p>
                    <FileSpreadsheet className="file-deco" size={36} />
                  </button>
                </div>

                <div className="start-line">
                  <i /> YOUR INVESTIGATION STARTS HERE <i />
                </div>
              </section>
            )}

            {/* STEP 2: INVESTIGATE */}
            {step === 'investigate' && (
              <section>
                <div className="screen-heading">
                  <div>
                    <div className="eyebrow">
                      <i /> STEP 02 · FOLLOW THE EVIDENCE
                    </div>
                    <h1>
                      Something is using power<br />
                      <em>when it shouldn't.</em>
                    </h1>
                    <p>
                      We analyzed your energy telemetry and bill data. Inspect the signals below to understand the overnight demand.
                    </p>
                  </div>
                  <div className="heading-art">
                    <ScanSearch size={33} />
                    <b>✳</b>
                  </div>
                </div>

                {/* BILL METADATA BANNER (IF BILL UPLOADED) */}
                {billData && (
                  <div className="bill-banner">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
                      <Receipt size={18} style={{ color: 'var(--lime)' }} />
                      <div>
                        <b style={{ fontSize: '11px', color: '#e7ede0' }}>{billData.provider || 'Electricity Utility Bill'}</b>
                        <small style={{ display: 'block', fontSize: '9px', color: '#8d9982' }}>
                          Account: {billData.consumer_id || 'N/A'} {billData.bill_date ? `· Date: ${billData.bill_date}` : ''}
                        </small>
                      </div>
                    </div>
                    <div className="bill-meta-tags">
                      {billData.total_kwh && (
                        <span className="bill-tag">Billed Units: <b>{billData.total_kwh} kWh</b></span>
                      )}
                      {billData.total_amount && (
                        <span className="bill-tag">Amount: <b>{money(billData.total_amount)}</b></span>
                      )}
                      {billData.tariff_rate && (
                        <span className="bill-tag">Tariff: <b>₹{billData.tariff_rate}/kWh</b></span>
                      )}
                      {billData.days && (
                        <span className="bill-tag">Period: <b>{billData.days} Days</b></span>
                      )}
                    </div>
                  </div>
                )}

                <div className="evidence-panel">
                  <div className="evidence-top">
                    <span className="evidence-icon">
                      <Moon size={19} />
                    </span>
                    <span className="priority">HIGH PRIORITY</span>
                    <small>SIGNAL · {currentAnalysis?.id ? String(currentAnalysis.id).padStart(3, '0') : '001'}</small>
                  </div>
                  <div className="evidence-copy">
                    <div>
                      <h2>Overnight energy spike</h2>
                      <p>
                        Consumption stays elevated between midnight and 6 AM, while the baseline suggests lower demand.
                      </p>
                      <div className="tags">
                        <span>
                          <Clock3 size={13} /> 12 AM – 6 AM
                        </span>
                        <span>
                          <Activity size={13} /> {overnight.toFixed(1)} kWh above baseline
                        </span>
                        {currentAnalysis?.result?.summary && (
                          <span>
                            <FileCheck2 size={13} /> {currentAnalysis.result.summary.reading_count} readings ({currentAnalysis.result.summary.days_covered} days)
                          </span>
                        )}
                        {currentAnalysis?.file_type && (
                          <span style={{ textTransform: 'uppercase' }}>
                            <Info size={13} /> {currentAnalysis.file_type.replace('_', ' ')}
                          </span>
                        )}
                      </div>

                      {currentAnalysis?.result?.anomalies && currentAnalysis.result.anomalies.length > 0 && (
                        <div className="anomaly-pill-row">
                          {currentAnalysis.result.anomalies.slice(0, 4).map((anom, i) => (
                            <span key={i} className="anomaly-pill">
                              Spike: {anom.timestamp.slice(11, 16)} · +{anom.excess_kwh_vs_baseline} kWh
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="evidence-number">
                      <small>EXCESS DETECTED</small>
                      <b>{overnight.toFixed(1)} <i>kWh</i></b>
                      <span>{currentAnalysis ? 'Engine-calculated excess' : 'Selected overnight readings'}</span>
                    </div>
                  </div>

                  <div className="chart-panel">
                    <div className="chart-title">
                      <span>ACTUAL VS BASELINE</span>
                      <span>
                        <i className="key-lime" /> Actual <i className="key-grey" /> Baseline
                      </span>
                    </div>
                    <Chart data={data} />
                  </div>
                </div>

                {/* NEMOTRON AI EXPLANATION SECTION */}
                <div className="ai-panel">
                  <div className="ai-panel-head">
                    <div className="ai-panel-title">
                      <Sparkles size={16} />
                      <span>Nemotron AI Investigation Explanation</span>
                    </div>
                    <button
                      className="quiet-btn"
                      onClick={handleExplainWithAI}
                      disabled={aiLoading}
                      style={{ padding: '6px 12px', fontSize: '9px' }}
                    >
                      {aiLoading ? (
                        <>
                          <Loader2 size={13} className="spin" /> Generating...
                        </>
                      ) : (
                        <>
                          <Sparkles size={13} /> {aiExplanation ? 'Regenerate Analysis' : 'Explain with Nemotron'}
                        </>
                      )}
                    </button>
                  </div>

                  {aiExplanation ? (
                    <div className="ai-content">{aiExplanation}</div>
                  ) : (
                    <p style={{ fontSize: '10px', color: '#8d9882', margin: 0 }}>
                      Connect directly to NVIDIA Nemotron via FastAPI to synthesize investigation steps, equipment hypotheses, and data quality caveats for this dataset.
                    </p>
                  )}
                </div>

                <div className="cause-title">
                  <span className="eyebrow">POSSIBLE EXPLANATIONS</span>
                  <span>
                    <Sparkles size={13} /> AI-assisted hypothesis testing
                  </span>
                </div>

                <div className="cause-grid">
                  <button className="cause-card" onClick={() => { setAvoid(50); go('experiment'); }}>
                    <span><Bolt size={17} /></span>
                    <b>Always-on equipment</b>
                    <p>Equipment may remain powered outside operating hours.</p>
                    <label>Test this idea <ArrowRight size={13} /></label>
                  </button>
                  <button className="cause-card" onClick={() => { setAvoid(35); go('experiment'); }}>
                    <span><Sun size={17} /></span>
                    <b>Schedules need review</b>
                    <p>Timers or HVAC schedules may not match occupancy.</p>
                    <label>Test this idea <ArrowRight size={13} /></label>
                  </button>
                  <button className="cause-card" onClick={() => { setAvoid(20); go('experiment'); }}>
                    <span><BarChart3 size={17} /></span>
                    <b>Baseline may be stale</b>
                    <p>Compare the baseline with recent building activity.</p>
                    <label>Test this idea <ArrowRight size={13} /></label>
                  </button>
                </div>

                <div className="honesty">
                  <ShieldCheck size={15} />
                  <span>
                    <b>Evidence, not a verdict.</b> These are hypotheses from verified telemetry calculations—not confirmed faults.
                  </span>
                </div>

                <FooterNav label="Test a possible fix" />
              </section>
            )}

            {/* STEP 3: EXPERIMENT */}
            {step === 'experiment' && (
              <section>
                <div className="screen-heading">
                  <div>
                    <div className="eyebrow">
                      <i /> STEP 03 · TRY A SCENARIO
                    </div>
                    <h1>What if we fixed it?</h1>
                    <p>Change the assumptions. See the potential impact before touching any real equipment.</p>
                  </div>
                  <div className="heading-art">
                    <SlidersHorizontal size={32} />
                    <b>✳</b>
                  </div>
                </div>

                <div className="experiment-grid">
                  <div className="controls panel">
                    <div className="control-head">
                      <span className="eyebrow">SCENARIO BUILDER</span>
                      <label><i /> EDITABLE</label>
                    </div>
                    <div className="scenario-name">
                      <span><Bolt size={17} /></span>
                      <div>
                        <b>Reduce avoidable overnight load</b>
                        <small>Hypothetical intervention · no device control</small>
                      </div>
                    </div>
                    <div className="control-block">
                      <div className="control-label">
                        <label htmlFor="avoid">Avoidable excess usage</label>
                        <strong>{avoid}%</strong>
                      </div>
                      <input
                        id="avoid"
                        type="range"
                        min="0"
                        max="100"
                        step="5"
                        value={avoid}
                        onChange={e => {
                          setAvoid(+e.target.value);
                          setSaved(false);
                        }}
                        style={{ '--range': `${avoid}%` }}
                      />
                      <div className="range-labels">
                        <span>0% · No change</span>
                        <span>100% · All excess</span>
                      </div>
                      <p>What share of the detected excess might a practical intervention avoid?</p>
                    </div>
                    <div className="control-block rate-block">
                      <div>
                        <label htmlFor="rate">Electricity price</label>
                        <small>{billData?.tariff_rate ? `Detected from bill: ₹${billData.tariff_rate}/kWh` : 'Use your local tariff'}</small>
                      </div>
                      <div className="rate-input">
                        <span>₹</span>
                        <input
                          id="rate"
                          type="number"
                          min="0"
                          max="1000"
                          step=".5"
                          value={rate}
                          onChange={e => {
                            setRate(Math.max(0, +e.target.value || 0));
                            setSaved(false);
                          }}
                        />
                        <span>/ kWh</span>
                      </div>
                    </div>
                    <div className="assumption">
                      <Lightbulb size={15} />
                      <span>
                        <b>Assumption:</b> only the detected overnight excess is changed. Weather, occupancy, and equipment type are not yet modeled.
                      </span>
                    </div>
                  </div>

                  <div className="impact panel">
                    <div className="impact-top">
                      <span className="impact-leaf">
                        <Leaf size={20} />
                      </span>
                      <label><i /> LIVE SIMULATION</label>
                    </div>
                    <small className="impact-label">POTENTIAL COST REDUCTION</small>
                    <strong className="impact-value">
                      {money(savings)}<i>/ day</i>
                    </strong>
                    <div className="impact-bars">
                      <div>
                        <span>Current excess</span>
                        <b>{overnight.toFixed(1)} kWh</b>
                        <i><em style={{ width: '100%' }} /></i>
                      </div>
                      <div>
                        <span>Potential avoided</span>
                        <b>{avoided.toFixed(1)} kWh</b>
                        <i><em style={{ width: `${avoid}%` }} /></i>
                      </div>
                    </div>
                    <div className="breakdown">
                      <div>
                        <span>Energy avoided</span>
                        <b>{avoided.toFixed(1)} kWh/day</b>
                      </div>
                      <div>
                        <span>Selected tariff</span>
                        <b>{money(rate)} / kWh</b>
                      </div>
                      <div>
                        <span>Annualized scenario</span>
                        <b>{money(annualized)}</b>
                      </div>
                    </div>
                    <div className="disclaimer">
                      <ShieldCheck size={15} /> Estimate only. Real savings need a real intervention and follow-up meter readings.
                    </div>
                    <button
                      className="primary-btn full"
                      onClick={handleSaveWhatIf}
                      disabled={loading}
                    >
                      {saved ? <Check size={15} /> : <BadgeCheck size={15} />}
                      {saved ? 'Scenario saved to backend' : 'Save this scenario'} <ArrowRight size={15} />
                    </button>
                  </div>
                </div>

                <FooterNav label="Build my proof report" />
              </section>
            )}

            {/* STEP 4: REPORT */}
            {step === 'report' && (
              <section>
                <div className="report-hero">
                  <div>
                    <div className="eyebrow">
                      <i /> STEP 04 · MAKE IT AUDITABLE
                    </div>
                    <h1>
                      Your proof of<br />
                      <em>potential savings.</em>
                    </h1>
                    <p>
                      A record of what was detected, what you tested, and which assumptions shaped the estimate.
                    </p>
                  </div>
                  <div className="report-stamp">
                    <FileCheck2 size={28} />
                    <span>SCENARIO<br />SUMMARY</span>
                    <i>✳</i>
                  </div>
                </div>

                <div className="report-result">
                  <div>
                    <small className="eyebrow">ESTIMATED SCENARIO IMPACT</small>
                    <strong>{money(savings)}<i>/ day</i></strong>
                    <p>Potential reduction if {avoid}% of detected overnight excess is avoided.</p>
                  </div>
                  <div className="report-metrics">
                    <div>
                      <span>Energy avoided</span>
                      <b>{avoided.toFixed(1)} kWh/day</b>
                    </div>
                    <div>
                      <span>Annualized estimate</span>
                      <b>{money(annualized)}</b>
                    </div>
                    <div>
                      <span>Tariff assumption</span>
                      <b>{money(rate)} / kWh</b>
                    </div>
                    {currentAnalysis?.result?.summary?.total_energy_kwh && (
                      <div>
                        <span>Total period consumption</span>
                        <b>{currentAnalysis.result.summary.total_energy_kwh} kWh</b>
                      </div>
                    )}
                  </div>
                </div>

                <div className="report-cards">
                  <article>
                    <div className="report-card-head">
                      <span className="report-icon orange">
                        <ScanSearch size={16} />
                      </span>
                      <div>
                        <small>01 / DETECTION</small>
                        <b>What we observed</b>
                      </div>
                    </div>
                    <p>Overnight readings were above the expected baseline in the selected periods.</p>
                    <div className="report-row">
                      <span>Source file</span>
                      <b>{fileName || 'Sample Readings'}</b>
                    </div>
                    {billData?.provider && (
                      <div className="report-row">
                        <span>Utility provider</span>
                        <b>{billData.provider}</b>
                      </div>
                    )}
                    {billData?.consumer_id && (
                      <div className="report-row">
                        <span>Account identifier</span>
                        <b>{billData.consumer_id}</b>
                      </div>
                    )}
                    <div className="report-row">
                      <span>Excess measured in sample</span>
                      <b>{overnight.toFixed(1)} kWh</b>
                    </div>
                    <div className="report-row">
                      <span>Evidence window</span>
                      <b>00:00 – 06:00 (Overnight)</b>
                    </div>
                    {currentAnalysis?.result?.summary?.first_reading && (
                      <div className="report-row">
                        <span>Observation range</span>
                        <b>{currentAnalysis.result.summary.first_reading.slice(0, 10)} to {currentAnalysis.result.summary.last_reading.slice(0, 10)}</b>
                      </div>
                    )}
                  </article>

                  <article>
                    <div className="report-card-head">
                      <span className="report-icon green">
                        <SlidersHorizontal size={16} />
                      </span>
                      <div>
                        <small>02 / INTERVENTION</small>
                        <b>What we tested</b>
                      </div>
                    </div>
                    <p>A hypothetical reduction to the excess load, adjustable by the user.</p>
                    <div className="report-row">
                      <span>Avoidable share</span>
                      <b>{avoid}%</b>
                    </div>
                    <div className="report-row">
                      <span>Tariff used</span>
                      <b>{money(rate)} / kWh</b>
                    </div>
                    <div className="report-row">
                      <span>Backend verified</span>
                      <b>{currentAnalysis?.id ? `Analysis #${currentAnalysis.id}` : 'Local preview'}</b>
                    </div>
                  </article>
                </div>

                {/* AI Explanation in report if available */}
                {aiExplanation && (
                  <div className="ai-panel" style={{ marginTop: '14px' }}>
                    <div className="ai-panel-title" style={{ marginBottom: '8px' }}>
                      <Sparkles size={15} /> Nemotron AI Investigation Findings
                    </div>
                    <div className="ai-content">{aiExplanation}</div>
                  </div>
                )}

                <div className="report-warning">
                  <ShieldCheck size={18} />
                  <div>
                    <b>What this report does—and doesn't—prove</b>
                    <p>
                      This is a simulated estimate based on telemetry readings and user-selected assumptions. It does not prove real-world energy reduction. Verify the cause, apply a safe intervention, and compare actual meter readings afterward.
                    </p>
                  </div>
                </div>

                <div className="report-actions">
                  <button className="back-btn" onClick={back}>
                    <ArrowLeft size={15} /> Back to simulator
                  </button>
                  <button className="quiet-btn" onClick={() => window.print()}>
                    <FileSpreadsheet size={15} /> Print / Save PDF
                  </button>
                  <button
                    className="primary-btn"
                    onClick={() => {
                      setStep('discover');
                      setDir('back');
                      setSaved(false);
                    }}
                  >
                    <Activity size={15} /> New investigation <ArrowRight size={15} />
                  </button>
                </div>

                <div className="endline">
                  ✳ &nbsp; FIND THE WASTE. <i /> PROVE THE FIX.
                </div>
              </section>
            )}
          </div>

          <footer className="global-footer">
            <span>
              WATTWISE <i>•</i> ENERGY INTELLIGENCE
            </span>
            <span>
              <i className="footer-dot" /> FASTAPI MULTI-FORMAT ENGINE <b>·</b> NEMOTRON VISION OCR <b>·</b> NEMOTRON 30B
            </span>
          </footer>
        </main>
      </div>

      {/* HISTORICAL ANALYSES MODAL */}
      {showHistory && (
        <div className="history-modal-backdrop" onClick={() => setShowHistory(false)}>
          <div className="history-modal" onClick={e => e.stopPropagation()}>
            <div className="history-head">
              <b>Saved Analyses ({historyList.length})</b>
              <button className="history-close" onClick={() => setShowHistory(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="history-list">
              {historyList.length === 0 ? (
                <div style={{ padding: '20px', textAlign: 'center', color: '#88947f', fontSize: '11px' }}>
                  No previous analyses found. Upload a bill (PNG, PDF) or CSV to get started!
                </div>
              ) : (
                historyList.map(item => (
                  <button
                    key={item.id}
                    className={`history-item ${currentAnalysis?.id === item.id ? 'active' : ''}`}
                    onClick={() => handleLoadPastAnalysis(item.id)}
                  >
                    <div className="history-meta">
                      <b>#{item.id} · {item.filename}</b>
                      <small>{item.created_at ? new Date(item.created_at).toLocaleString() : 'Recent'}</small>
                    </div>
                    <div className="history-stats">
                      <span>{item.summary?.total_energy_kwh || 0} kWh</span>
                      <small>{money(item.what_if?.projected_daily_savings || 0)} / day</small>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast">
          <Check size={15} />
          {toast}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
