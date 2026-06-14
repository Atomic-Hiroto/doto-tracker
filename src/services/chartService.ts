import { createCanvas } from '@napi-rs/canvas';

export interface DataPoint {
    label: string;
    value: number;
}

const CHART_WIDTH = 800;
const CHART_HEIGHT = 400;
const PADDING = 60;

function drawLineChart(
    title: string,
    data: DataPoint[],
    color: string,
    yLabel: string
): Buffer {
    const canvas = createCanvas(CHART_WIDTH, CHART_HEIGHT);
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, CHART_WIDTH, CHART_HEIGHT);

    // Border
    ctx.strokeStyle = '#2d2d4e';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, CHART_WIDTH - 2, CHART_HEIGHT - 2);

    if (data.length < 2) {
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 20px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Not enough data', CHART_WIDTH / 2, CHART_HEIGHT / 2);
        return canvas.toBuffer('image/png');
    }

    const plotW = CHART_WIDTH - PADDING * 2;
    const plotH = CHART_HEIGHT - PADDING * 2;
    const values = data.map(d => d.value);
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    const valRange = maxVal - minVal || 1;

    const scaleX = (i: number) => PADDING + (i / (data.length - 1)) * plotW;
    const scaleY = (v: number) => CHART_HEIGHT - PADDING - ((v - minVal) / valRange) * plotH;

    // Grid lines
    ctx.strokeStyle = '#2d2d4e';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = PADDING + (plotH / 4) * i;
        ctx.beginPath();
        ctx.moveTo(PADDING, y);
        ctx.lineTo(CHART_WIDTH - PADDING, y);
        ctx.stroke();
        const gridVal = maxVal - (valRange / 4) * i;
        ctx.fillStyle = '#888899';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(gridVal.toFixed(1), PADDING - 8, y + 4);
    }

    // Line gradient
    const gradient = ctx.createLinearGradient(0, PADDING, 0, CHART_HEIGHT - PADDING);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, color + '44');

    // Area fill
    ctx.beginPath();
    ctx.moveTo(scaleX(0), CHART_HEIGHT - PADDING);
    data.forEach((d, i) => ctx.lineTo(scaleX(i), scaleY(d.value)));
    ctx.lineTo(scaleX(data.length - 1), CHART_HEIGHT - PADDING);
    ctx.closePath();
    ctx.fillStyle = color + '22';
    ctx.fill();

    // Main line
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    data.forEach((d, i) => {
        if (i === 0) ctx.moveTo(scaleX(i), scaleY(d.value));
        else ctx.lineTo(scaleX(i), scaleY(d.value));
    });
    ctx.stroke();

    // Data points
    data.forEach((d, i) => {
        ctx.beginPath();
        ctx.arc(scaleX(i), scaleY(d.value), 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#1a1a2e';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    });

    // X-axis labels (show first, last, and midpoints)
    const labelIndices = [0, Math.floor(data.length / 4), Math.floor(data.length / 2), Math.floor(3 * data.length / 4), data.length - 1];
    ctx.fillStyle = '#888899';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    labelIndices.forEach(i => {
        if (i < data.length) {
            ctx.fillText(data[i].label.slice(0, 8), scaleX(i), CHART_HEIGHT - PADDING + 20);
        }
    });

    // Title
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(title, CHART_WIDTH / 2, 30);

    // Y-axis label
    ctx.save();
    ctx.translate(16, CHART_HEIGHT / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = '#888899';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();

    return canvas.toBuffer('image/png');
}

/**
 * Renders the iconic Dota "advantage over time" graph: gold advantage as a
 * diverging green/red filled area (Radiant positive, Dire negative) with the XP
 * advantage drawn as a line on top. Centered on a zero baseline.
 */
export function renderMatchAdvantageGraph(
    radiantGoldAdv: number[],
    radiantXpAdv: number[],
    opts?: { title?: string; radiantWin?: boolean }
): Buffer {
    const W = 900;
    const H = 420;
    const P = 64;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#2d2d4e';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);

    const gold = radiantGoldAdv || [];
    const xp = radiantXpAdv || [];
    const n = Math.max(gold.length, xp.length);

    if (n < 2) {
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 20px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No timeline data (match not parsed)', W / 2, H / 2);
        return canvas.toBuffer('image/png');
    }

    const plotW = W - P * 2;
    const plotH = H - P * 2;
    const all = [...gold, ...xp];
    const maxAbs = Math.max(1, ...all.map((v) => Math.abs(v)));

    const scaleX = (i: number) => P + (i / (n - 1)) * plotW;
    const midY = P + plotH / 2;
    const scaleY = (v: number) => midY - (v / maxAbs) * (plotH / 2);

    // Horizontal grid + value labels (in thousands)
    ctx.strokeStyle = '#2d2d4e';
    ctx.lineWidth = 1;
    ctx.font = '12px sans-serif';
    for (let i = -2; i <= 2; i++) {
        const val = (maxAbs / 2) * i;
        const y = scaleY(val);
        ctx.strokeStyle = i === 0 ? '#52527a' : '#2d2d4e';
        ctx.beginPath();
        ctx.moveTo(P, y);
        ctx.lineTo(W - P, y);
        ctx.stroke();
        ctx.fillStyle = '#888899';
        ctx.textAlign = 'right';
        ctx.fillText(`${(val / 1000).toFixed(1)}k`, P - 8, y + 4);
    }

    // Diverging gold-advantage area, split at the zero baseline.
    const drawArea = (positive: boolean) => {
        ctx.beginPath();
        ctx.moveTo(scaleX(0), midY);
        for (let i = 0; i < gold.length; i++) {
            const v = positive ? Math.max(0, gold[i]) : Math.min(0, gold[i]);
            ctx.lineTo(scaleX(i), scaleY(v));
        }
        ctx.lineTo(scaleX(gold.length - 1), midY);
        ctx.closePath();
        ctx.fillStyle = positive ? '#10b98144' : '#ef444444';
        ctx.fill();
    };
    drawArea(true);
    drawArea(false);

    // Gold advantage line
    ctx.beginPath();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    gold.forEach((v, i) => (i === 0 ? ctx.moveTo(scaleX(i), scaleY(v)) : ctx.lineTo(scaleX(i), scaleY(v))));
    ctx.stroke();

    // XP advantage line
    ctx.beginPath();
    ctx.strokeStyle = '#60a5fa';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    xp.forEach((v, i) => (i === 0 ? ctx.moveTo(scaleX(i), scaleY(v)) : ctx.lineTo(scaleX(i), scaleY(v))));
    ctx.stroke();
    ctx.setLineDash([]);

    // X-axis minute labels
    ctx.fillStyle = '#888899';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    const step = Math.max(1, Math.round(n / 8));
    for (let i = 0; i < n; i += step) {
        ctx.fillText(`${i}m`, scaleX(i), H - P + 20);
    }

    // Title
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(opts?.title || 'Gold & XP Advantage (Radiant)', W / 2, 30);

    // Legend
    const legend = [
        { c: '#f59e0b', t: 'Gold adv' },
        { c: '#60a5fa', t: 'XP adv' },
        { c: '#10b981', t: 'Radiant ahead' },
        { c: '#ef4444', t: 'Dire ahead' },
    ];
    let lx = P;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    for (const item of legend) {
        ctx.fillStyle = item.c;
        ctx.fillRect(lx, 44, 12, 12);
        ctx.fillStyle = '#cccccc';
        ctx.fillText(item.t, lx + 16, 54);
        lx += 30 + ctx.measureText(item.t).width + 16;
    }

    return canvas.toBuffer('image/png');
}

export interface MatchRow {
    won: boolean;
    hero: string;
    kills: number;
    deaths: number;
    assists: number;
    gpm: number;
    durationSec: number;
    mode: string;
}

/**
 * Renders a clean, premium-looking recent-matches table as a PNG: one row per
 * match with a green/red result bar, hero, K/D/A, KDA ratio, GPM, duration and
 * mode. Far more readable than plain embed text rows.
 */
export function renderRecentMatchesTable(
    rows: MatchRow[],
    opts: { username: string; wins: number; total: number; subtitle?: string }
): Buffer {
    const W = 820;
    const HEADER_H = 84;
    const ROW_H = 40;
    const FOOTER_H = 12;
    const H = HEADER_H + rows.length * ROW_H + FOOTER_H;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#15151f';
    ctx.fillRect(0, 0, W, H);

    // Header band
    ctx.fillStyle = '#1f1f33';
    ctx.fillRect(0, 0, W, HEADER_H);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(opts.username, 24, 38);

    const wr = opts.total ? ((opts.wins / opts.total) * 100).toFixed(0) : '0';
    ctx.font = '15px sans-serif';
    ctx.fillStyle = '#9aa0c0';
    const summary = `Last ${opts.total} • ${opts.wins}W ${opts.total - opts.wins}L • ${wr}% WR${opts.subtitle ? `  •  ${opts.subtitle}` : ''}`;
    ctx.fillText(summary, 24, 64);

    // Column layout
    const cols = {
        hero: 64,
        kda: 320,
        ratio: 470,
        gpm: 570,
        dur: 670,
        mode: 740,
    };

    // Column headers
    const colHeaderY = HEADER_H - 6;
    ctx.font = 'bold 12px sans-serif';
    ctx.fillStyle = '#6b6b8a';
    ctx.textAlign = 'left';
    ctx.fillText('HERO', cols.hero, colHeaderY);
    ctx.fillText('K / D / A', cols.kda, colHeaderY);
    ctx.fillText('KDA', cols.ratio, colHeaderY);
    ctx.fillText('GPM', cols.gpm, colHeaderY);
    ctx.fillText('TIME', cols.dur, colHeaderY);
    ctx.fillText('MODE', cols.mode, colHeaderY);

    // Rows
    rows.forEach((r, i) => {
        const y = HEADER_H + i * ROW_H;
        // Zebra striping
        if (i % 2 === 0) {
            ctx.fillStyle = '#1a1a28';
            ctx.fillRect(0, y, W, ROW_H);
        }
        // Result bar
        ctx.fillStyle = r.won ? '#10b981' : '#ef4444';
        ctx.fillRect(0, y, 6, ROW_H);

        const ty = y + ROW_H / 2 + 5;
        ctx.textAlign = 'left';

        // Result pill letter
        ctx.font = 'bold 14px sans-serif';
        ctx.fillStyle = r.won ? '#10b981' : '#ef4444';
        ctx.fillText(r.won ? 'W' : 'L', 24, ty);

        // Hero
        ctx.font = '15px sans-serif';
        ctx.fillStyle = '#e6e6f0';
        ctx.fillText(truncatePx(ctx, r.hero, 240), cols.hero, ty);

        // K/D/A
        ctx.fillStyle = '#c4c4d8';
        ctx.fillText(`${r.kills} / ${r.deaths} / ${r.assists}`, cols.kda, ty);

        // KDA ratio
        const ratio = (r.kills + r.assists) / (r.deaths || 1);
        ctx.fillStyle = ratio >= 5 ? '#10b981' : ratio >= 3 ? '#eab308' : '#c4c4d8';
        ctx.fillText(ratio.toFixed(2), cols.ratio, ty);

        // GPM
        ctx.fillStyle = '#f59e0b';
        ctx.fillText(String(r.gpm), cols.gpm, ty);

        // Duration
        ctx.fillStyle = '#9aa0c0';
        const m = Math.floor(r.durationSec / 60);
        const s = r.durationSec % 60;
        ctx.fillText(`${m}:${s.toString().padStart(2, '0')}`, cols.dur, ty);

        // Mode
        ctx.font = '13px sans-serif';
        ctx.fillStyle = '#7b7b9a';
        ctx.fillText(truncatePx(ctx, r.mode, 70), cols.mode, ty);
    });

    return canvas.toBuffer('image/png');
}

function truncatePx(ctx: any, text: string, maxPx: number): string {
    if (ctx.measureText(text).width <= maxPx) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxPx) t = t.slice(0, -1);
    return t + '…';
}

export function renderKDATrend(matches: Array<{ kills: number; deaths: number; assists: number; match_id: number; start_time: number }>): Buffer {
    const data: DataPoint[] = matches.map(m => ({
        label: new Date(m.start_time * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }),
        value: parseFloat(((m.kills + m.assists) / (m.deaths || 1)).toFixed(2)),
    }));
    return drawLineChart('KDA Trend', data, '#7c3aed', 'KDA');
}

export function renderGPMTrend(matches: Array<{ gold_per_min: number; xp_per_min: number; match_id: number; start_time: number }>): Buffer {
    const data: DataPoint[] = matches.map(m => ({
        label: new Date(m.start_time * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }),
        value: m.gold_per_min,
    }));
    return drawLineChart('GPM Trend', data, '#f59e0b', 'GPM');
}

export function renderWinRateTrend(matches: Array<{ radiant_win: boolean; player_slot: number; start_time: number }>): Buffer {
    let wins = 0;
    const data: DataPoint[] = matches.map((m, i) => {
        const isRadiant = m.player_slot < 128;
        const won = (isRadiant && m.radiant_win) || (!isRadiant && !m.radiant_win);
        if (won) wins++;
        return {
            label: new Date(m.start_time * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }),
            value: parseFloat(((wins / (i + 1)) * 100).toFixed(1)),
        };
    });
    return drawLineChart('Rolling Win Rate (%)', data, '#10b981', 'Win Rate %');
}
