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
