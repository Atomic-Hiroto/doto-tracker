import { createCanvas, loadImage } from '@napi-rs/canvas';
import { dotaDataService } from './dotaDataService';
import { APIConstants } from '../constants';

const SCOREBOARD_GAME_MODES: Record<number, string> = {
    0: 'Unknown', 1: 'All Pick', 2: 'Captains Mode', 3: 'Random Draft',
    4: 'Single Draft', 5: 'All Random', 8: 'Reverse Captains Mode',
    16: 'Captains Draft', 22: 'All Draft', 23: 'Turbo', 24: 'Mutation',
};

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
    heroImageUrl?: string;
    kills: number;
    deaths: number;
    assists: number;
    gpm: number;
    durationSec: number;
    mode: string;
}

export interface ScoreboardPlayer {
    heroName: string;
    heroImageUrl?: string;
    personaName: string;
    level: number;
    kills: number;
    deaths: number;
    assists: number;
    gpm: number;
    lastHits: number;
    netWorth: number;
    itemImageUrls: (string | undefined)[];
    isFocus?: boolean;
}

export interface ScoreboardTeam {
    name: string;
    won: boolean;
    score: number;
    players: ScoreboardPlayer[];
}

/**
 * Renders an OpenDota-style match scoreboard PNG: a header band with the result
 * and duration, then both teams with hero portrait, name+level, K/D/A, GPM, net
 * worth, last hits and the end-game item icons. The focus player's row (if any)
 * is highlighted. Far richer than a plain text scoreboard.
 */
export async function renderMatchScoreboard(
    radiant: ScoreboardTeam,
    dire: ScoreboardTeam,
    opts: { matchId: number; durationSec: number; mode: string },
): Promise<Buffer> {
    const W = 940;
    const HEADER_H = 72;
    const TEAM_HEADER_H = 30;
    const ROW_H = 46;
    const GAP = 14;
    const teamBlockH = (team: ScoreboardTeam) => TEAM_HEADER_H + team.players.length * ROW_H;
    const H = HEADER_H + teamBlockH(radiant) + GAP + teamBlockH(dire) + 16;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#15151f';
    ctx.fillRect(0, 0, W, H);

    // Header band
    ctx.fillStyle = '#1f1f33';
    ctx.fillRect(0, 0, W, HEADER_H);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'left';
    const winner = radiant.won ? radiant.name : dire.name;
    ctx.fillText(`Match #${opts.matchId} — ${winner} Victory`, 22, 34);

    const m = Math.floor(opts.durationSec / 60);
    const s = opts.durationSec % 60;
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#9aa0c0';
    ctx.fillText(`${radiant.score}–${dire.score}  •  ${m}:${s.toString().padStart(2, '0')}  •  ${opts.mode}`, 22, 58);

    // Column anchors
    const cols = { hero: 16, name: 78, kda: 318, gpm: 452, nw: 540, lh: 632, items: 706 };
    const ITEM_W = 30;
    const ITEM_H = 23;
    const ITEM_GAP = 4;

    const drawTeam = async (team: ScoreboardTeam, top: number) => {
        // Team header
        ctx.fillStyle = team.won ? '#143d2c' : '#3d1a1a';
        ctx.fillRect(0, top, W, TEAM_HEADER_H);
        ctx.fillStyle = team.won ? '#10b981' : '#ef4444';
        ctx.fillRect(0, top, 6, TEAM_HEADER_H);
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillStyle = team.won ? '#34d399' : '#f87171';
        ctx.fillText(`${team.won ? '👑 ' : ''}${team.name}`, cols.hero, top + 20);
        // Column headers
        ctx.font = 'bold 11px sans-serif';
        ctx.fillStyle = '#6b6b8a';
        ctx.fillText('K / D / A', cols.kda, top + 20);
        ctx.fillText('GPM', cols.gpm, top + 20);
        ctx.fillText('NET', cols.nw, top + 20);
        ctx.fillText('LH', cols.lh, top + 20);
        ctx.fillText('ITEMS', cols.items, top + 20);

        for (const [i, p] of team.players.entries()) {
            const y = top + TEAM_HEADER_H + i * ROW_H;
            if (p.isFocus) {
                ctx.fillStyle = '#2a2a44';
                ctx.fillRect(0, y, W, ROW_H);
                ctx.fillStyle = '#7c3aed';
                ctx.fillRect(0, y, 4, ROW_H);
            } else if (i % 2 === 0) {
                ctx.fillStyle = '#1a1a28';
                ctx.fillRect(0, y, W, ROW_H);
            }

            const midY = y + ROW_H / 2;

            // Hero portrait (16:9)
            const heroImg = await loadCachedImage(p.heroImageUrl);
            const hw = 52;
            const hh = 29;
            const hy = midY - hh / 2;
            if (heroImg) {
                ctx.save();
                ctx.beginPath();
                ctx.roundRect(cols.hero, hy, hw, hh, 4);
                ctx.clip();
                ctx.drawImage(heroImg, cols.hero, hy, hw, hh);
                ctx.restore();
            }
            // Level badge
            ctx.fillStyle = '#0d0d16';
            ctx.beginPath();
            ctx.arc(cols.hero + hw - 6, hy + hh - 4, 9, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#ffd24a';
            ctx.font = 'bold 11px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(String(p.level), cols.hero + hw - 6, hy + hh);

            // Name + hero
            ctx.textAlign = 'left';
            ctx.font = 'bold 14px sans-serif';
            ctx.fillStyle = p.isFocus ? '#c4b5fd' : '#e6e6f0';
            ctx.fillText(truncatePx(ctx, p.personaName || 'Anonymous', 228), cols.name, midY - 2);
            ctx.font = '11px sans-serif';
            ctx.fillStyle = '#8a8aa8';
            ctx.fillText(truncatePx(ctx, p.heroName, 228), cols.name, midY + 13);

            // K/D/A
            ctx.font = '14px sans-serif';
            ctx.fillStyle = '#c4c4d8';
            ctx.fillText(`${p.kills} / ${p.deaths} / ${p.assists}`, cols.kda, midY + 4);

            // GPM
            ctx.fillStyle = '#f59e0b';
            ctx.fillText(String(p.gpm), cols.gpm, midY + 4);

            // Net worth (k)
            ctx.fillStyle = '#fbbf24';
            ctx.fillText(p.netWorth ? `${(p.netWorth / 1000).toFixed(1)}k` : '—', cols.nw, midY + 4);

            // Last hits
            ctx.fillStyle = '#9aa0c0';
            ctx.fillText(String(p.lastHits), cols.lh, midY + 4);

            // Items
            for (let s = 0; s < 6; s++) {
                const ix = cols.items + s * (ITEM_W + ITEM_GAP);
                const iy = midY - ITEM_H / 2;
                ctx.fillStyle = '#0d0d16';
                ctx.beginPath();
                ctx.roundRect(ix, iy, ITEM_W, ITEM_H, 3);
                ctx.fill();
                const itemImg = await loadCachedImage(p.itemImageUrls[s]);
                if (itemImg) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.roundRect(ix, iy, ITEM_W, ITEM_H, 3);
                    ctx.clip();
                    ctx.drawImage(itemImg, ix, iy, ITEM_W, ITEM_H);
                    ctx.restore();
                }
            }
        }
    };

    await drawTeam(radiant, HEADER_H);
    await drawTeam(dire, HEADER_H + teamBlockH(radiant) + GAP);

    return canvas.toBuffer('image/png');
}

const imageCache = new Map<string, any | null>();

async function loadCachedImage(url?: string): Promise<any | null> {
    if (!url) return null;
    if (imageCache.has(url)) return imageCache.get(url) || null;
    try {
        const image = await loadImage(url);
        imageCache.set(url, image);
        return image;
    } catch {
        imageCache.set(url, null);
        return null;
    }
}

/**
 * Renders a clean, premium-looking recent-matches table as a PNG: one row per
 * match with a green/red result bar, hero, K/D/A, KDA ratio, GPM, duration and
 * mode. Far more readable than plain embed text rows.
 */
/**
 * Convenience wrapper: build both teams from a raw OpenDota match object and
 * render the scoreboard. focusSteamIds highlights those players' rows. Shared by
 * the +matches Details button and the auto-show feed so they stay identical.
 */
export async function renderScoreboardFromMatch(match: any, focusSteamIds: string[] = []): Promise<Buffer> {
    const focus = new Set(focusSteamIds.map(String));
    const toPlayer = async (p: any): Promise<ScoreboardPlayer> => {
        const hero = await dotaDataService.getHeroName(p.hero_id);
        return {
            heroName: hero,
            heroImageUrl: APIConstants.IMAGE_URL(hero),
            personaName: p.personaname || 'Anonymous',
            level: Number(p.level || 0),
            kills: p.kills ?? 0,
            deaths: p.deaths ?? 0,
            assists: p.assists ?? 0,
            gpm: p.gold_per_min ?? 0,
            lastHits: p.last_hits ?? 0,
            netWorth: Number(p.net_worth ?? p.total_gold ?? 0),
            itemImageUrls: ['item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5']
                .map((slot) => dotaDataService.getItemImageUrl(Number(p[slot] || 0))),
            isFocus: focus.has(String(p.account_id)),
        };
    };
    const radiantPlayers = (match.players || []).filter((p: any) => p.player_slot < 128);
    const direPlayers = (match.players || []).filter((p: any) => p.player_slot >= 128);
    const radiant: ScoreboardTeam = {
        name: 'Radiant', won: !!match.radiant_win, score: match.radiant_score ?? 0,
        players: await Promise.all(radiantPlayers.map(toPlayer)),
    };
    const dire: ScoreboardTeam = {
        name: 'Dire', won: !match.radiant_win, score: match.dire_score ?? 0,
        players: await Promise.all(direPlayers.map(toPlayer)),
    };
    const mode = SCOREBOARD_GAME_MODES[Number(match.game_mode)] || `Mode ${match.game_mode ?? '?'}`;
    return renderMatchScoreboard(radiant, dire, { matchId: match.match_id, durationSec: match.duration, mode });
}

export function renderRecentMatchesTable(
    rows: MatchRow[],
    opts: { username: string; wins: number; total: number; subtitle?: string }
): Buffer {
    return renderRecentMatchesTableCanvas(rows, opts).toBuffer('image/png');
}

export async function renderRecentMatchesTableWithIcons(
    rows: MatchRow[],
    opts: { username: string; wins: number; total: number; subtitle?: string }
): Promise<Buffer> {
    const canvas = renderRecentMatchesTableCanvas(rows, opts);
    const ctx = canvas.getContext('2d');
    for (const [i, row] of rows.entries()) {
        const image = await loadCachedImage(row.heroImageUrl);
        if (!image) continue;
        const y = 84 + i * 40 + 5;
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(58, y, 30, 30, 4);
        ctx.clip();
        ctx.drawImage(image, 58, y, 30, 30);
        ctx.restore();
    }
    return canvas.toBuffer('image/png');
}

function renderRecentMatchesTableCanvas(
    rows: MatchRow[],
    opts: { username: string; wins: number; total: number; subtitle?: string }
): any {
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
        hero: rows.some((row) => row.heroImageUrl) ? 96 : 64,
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

    return canvas;
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

export function renderSkillBuildGrid(
    upgrades: Array<{ time?: number; level?: number; abilityName: string }>,
    opts: { title: string; subtitle?: string }
): Buffer {
    const W = 900;
    const rowH = 42;
    const H = 104 + Math.max(1, upgrades.length) * rowH;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#15151f';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#1f1f33';
    ctx.fillRect(0, 0, W, 86);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(opts.title, 24, 36);
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#9aa0c0';
    ctx.fillText(opts.subtitle || 'Ability level-up order', 24, 62);

    const cols = { level: 28, time: 110, ability: 210 };
    ctx.font = 'bold 12px sans-serif';
    ctx.fillStyle = '#6b6b8a';
    ctx.fillText('LVL', cols.level, 82);
    ctx.fillText('TIME', cols.time, 82);
    ctx.fillText('ABILITY', cols.ability, 82);

    upgrades.forEach((upgrade, i) => {
        const y = 86 + i * rowH;
        if (i % 2 === 0) {
            ctx.fillStyle = '#1a1a28';
            ctx.fillRect(0, y, W, rowH);
        }
        ctx.font = 'bold 15px sans-serif';
        ctx.fillStyle = '#e6e6f0';
        ctx.fillText(String(upgrade.level ?? i + 1), cols.level, y + 27);
        ctx.font = '14px sans-serif';
        ctx.fillStyle = '#9aa0c0';
        ctx.fillText(formatClock(upgrade.time), cols.time, y + 27);
        ctx.fillStyle = '#c4c4d8';
        ctx.fillText(truncatePx(ctx, upgrade.abilityName, 620), cols.ability, y + 27);
    });
    if (!upgrades.length) {
        ctx.fillStyle = '#c4c4d8';
        ctx.font = '16px sans-serif';
        ctx.fillText('No skill build data found. The match may be unparsed.', 24, 126);
    }
    return canvas.toBuffer('image/png');
}

export function renderInventoryImage(
    rows: Array<{ label: string; items: string[]; count?: number }>,
    opts: { title: string; subtitle?: string }
): Buffer {
    const W = 900;
    const rowH = 46;
    const H = 96 + Math.max(1, rows.length) * rowH;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#15151f';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#1f1f33';
    ctx.fillRect(0, 0, W, 82);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(opts.title, 24, 36);
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#9aa0c0';
    ctx.fillText(opts.subtitle || '', 24, 62);
    rows.forEach((row, i) => {
        const y = 82 + i * rowH;
        if (i % 2 === 0) {
            ctx.fillStyle = '#1a1a28';
            ctx.fillRect(0, y, W, rowH);
        }
        ctx.font = 'bold 15px sans-serif';
        ctx.fillStyle = '#e6e6f0';
        ctx.fillText(truncatePx(ctx, row.label, 210), 24, y + 29);
        ctx.font = '14px sans-serif';
        ctx.fillStyle = '#c4c4d8';
        ctx.fillText(truncatePx(ctx, row.items.join(', ') || 'No items', 600), 260, y + 29);
        if (row.count != null) {
            ctx.fillStyle = '#9aa0c0';
            ctx.textAlign = 'right';
            ctx.fillText(`${row.count}x`, W - 28, y + 29);
            ctx.textAlign = 'left';
        }
    });
    if (!rows.length) {
        ctx.fillStyle = '#c4c4d8';
        ctx.font = '16px sans-serif';
        ctx.fillText('No inventory data found for this query.', 24, 122);
    }
    return canvas.toBuffer('image/png');
}

export function renderRoleDistribution(
    rows: Array<{ label: string; value: number; color: string }>,
    opts: { title: string; subtitle?: string }
): Buffer {
    const W = 720;
    const H = 360;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#15151f';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(opts.title, 24, 38);
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#9aa0c0';
    ctx.fillText(opts.subtitle || '', 24, 62);
    const total = Math.max(1, rows.reduce((sum, row) => sum + row.value, 0));
    let start = -Math.PI / 2;
    const cx = 190;
    const cy = 206;
    const radius = 104;
    for (const row of rows) {
        const angle = (row.value / total) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, radius, start, start + angle);
        ctx.closePath();
        ctx.fillStyle = row.color;
        ctx.fill();
        start += angle;
    }
    let y = 128;
    rows.forEach((row) => {
        ctx.fillStyle = row.color;
        ctx.fillRect(360, y - 12, 16, 16);
        ctx.fillStyle = '#e6e6f0';
        ctx.font = '15px sans-serif';
        ctx.fillText(`${row.label}: ${row.value} (${Math.round((row.value / total) * 100)}%)`, 386, y + 1);
        y += 34;
    });
    return canvas.toBuffer('image/png');
}

function formatClock(seconds?: number): string {
    if (!Number.isFinite(seconds)) return '—';
    const value = Number(seconds);
    const sign = value < 0 ? '-' : '';
    const abs = Math.abs(value);
    return `${sign}${Math.floor(abs / 60)}:${Math.floor(abs % 60).toString().padStart(2, '0')}`;
}

export interface TurboStudyPoint {
    label: string;
    x: number;
    y: number;
    confidence: number;
}

export function renderTurboStudyScatter(
    points: TurboStudyPoint[],
    opts: { title: string; xLabel: string; yLabel: string },
): Buffer {
    const W = 920;
    const H = 560;
    const P = 72;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#15151f';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#2d2d4e';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);

    if (points.length < 2) {
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 20px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Not enough data', W / 2, H / 2);
        return canvas.toBuffer('image/png');
    }

    const minX = Math.min(...points.map((p) => p.x));
    const maxX = Math.max(...points.map((p) => p.x));
    const minY = Math.min(...points.map((p) => p.y));
    const maxY = Math.max(...points.map((p) => p.y));
    const low = Math.floor((Math.min(minX, minY) - 250) / 500) * 500;
    const high = Math.ceil((Math.max(maxX, maxY) + 250) / 500) * 500;
    const range = Math.max(1, high - low);
    const plotW = W - P * 2;
    const plotH = H - P * 2;

    const sx = (x: number) => P + ((x - low) / range) * plotW;
    const sy = (y: number) => H - P - ((y - low) / range) * plotH;

    ctx.font = '12px sans-serif';
    for (let v = low; v <= high; v += 500) {
        const x = sx(v);
        const y = sy(v);
        ctx.strokeStyle = '#2d2d4e';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, P);
        ctx.lineTo(x, H - P);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(P, y);
        ctx.lineTo(W - P, y);
        ctx.stroke();

        ctx.fillStyle = '#8b8ba8';
        ctx.textAlign = 'center';
        ctx.fillText(String(v), x, H - P + 22);
        ctx.textAlign = 'right';
        ctx.fillText(String(v), P - 10, y + 4);
    }

    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(sx(low), sy(low));
    ctx.lineTo(sx(high), sy(high));
    ctx.stroke();
    ctx.setLineDash([]);

    for (const point of points) {
        const x = sx(point.x);
        const y = sy(point.y);
        const radius = 5 + Math.min(5, Math.max(0, point.confidence - 40) / 15);
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = point.y >= point.x ? '#8b5cf6' : '#60a5fa';
        ctx.fill();
        ctx.strokeStyle = '#ffffffcc';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.font = '11px sans-serif';
        ctx.fillStyle = '#e5e7eb';
        ctx.textAlign = 'left';
        ctx.fillText(point.label.slice(0, 12), x + radius + 4, y + 4);
    }

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(opts.title, W / 2, 34);

    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#a5a5c0';
    ctx.fillText(opts.xLabel, W / 2, H - 20);
    ctx.save();
    ctx.translate(22, H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(opts.yLabel, 0, 0);
    ctx.restore();

    ctx.textAlign = 'left';
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(P, 48, 16, 3);
    ctx.fillStyle = '#c7c7d9';
    ctx.font = '12px sans-serif';
    ctx.fillText('Equal ranked and Turbo estimate', P + 24, 53);

    return canvas.toBuffer('image/png');
}
