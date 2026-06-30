import { createCanvas, loadImage } from '@napi-rs/canvas';
import { dotaDataService } from './dotaDataService';
import { APIConstants } from '../constants';
import { MatchRankDisplay, resolveMatchRankDisplay } from './rankDisplayService';

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
    rankLabel?: string;
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
    rankLabel?: string;
    rankTier?: number;
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
    opts: { matchId: number; durationSec: number; mode: string; lobbyRankLabel?: string; visibleRankCount?: number },
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
    const rankSummary = opts.lobbyRankLabel
        ? `  •  Avg ${opts.lobbyRankLabel}${opts.visibleRankCount ? ` (${opts.visibleRankCount}/10 ranks)` : ''}`
        : '';
    ctx.fillText(
        truncatePx(ctx, `${radiant.score}–${dire.score}  •  ${m}:${s.toString().padStart(2, '0')}  •  ${opts.mode}${rankSummary}`, W - 44),
        22,
        58,
    );

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

            // Name + Dota medal + hero/rank
            ctx.textAlign = 'left';
            const medalSize = p.rankTier ? 23 : 0;
            const medalX = cols.name;
            const medalY = midY - 17;
            if (p.rankTier) {
                const icon = await loadCachedImage(rankIconUrl(p.rankTier));
                if (icon) {
                    ctx.drawImage(icon, medalX, medalY, medalSize, medalSize);
                }
                const star = await loadCachedImage(rankStarIconUrl(p.rankTier));
                if (star) {
                    ctx.drawImage(star, medalX, medalY, medalSize, medalSize);
                }
            }
            const textX = cols.name + (p.rankTier ? medalSize + 7 : 0);
            const textMaxPx = Math.max(110, cols.kda - textX - 12);
            ctx.font = 'bold 14px sans-serif';
            ctx.fillStyle = p.isFocus ? '#c4b5fd' : '#e6e6f0';
            ctx.fillText(truncatePx(ctx, p.personaName || 'Anonymous', textMaxPx), textX, midY - 2);
            ctx.font = '11px sans-serif';
            const subline = p.rankLabel ? `${p.heroName} • ${p.rankLabel}` : p.heroName;
            ctx.fillStyle = p.rankTier ? rankColor(p.rankTier) : '#8a8aa8';
            ctx.fillText(truncatePx(ctx, subline, textMaxPx), textX, midY + 13);

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
function rankColor(rankTier?: number): string {
    if (!rankTier) return '#6b6b8a';
    const colors: Record<number, string> = {
        1: '#b45309',
        2: '#22c55e',
        3: '#38bdf8',
        4: '#c084fc',
        5: '#facc15',
        6: '#fb923c',
        7: '#ef4444',
        8: '#f8fafc',
    };
    return colors[Math.floor(rankTier / 10)] ?? '#9aa0c0';
}

function rankIconUrl(rankTier: number): string {
    const tier = Math.min(8, Math.max(1, Math.floor(rankTier / 10)));
    return `https://www.opendota.com/assets/images/dota2/rank_icons/rank_icon_${tier}.png`;
}

function rankStarIconUrl(rankTier?: number): string | undefined {
    if (!rankTier) return undefined;
    const tier = Math.floor(rankTier / 10);
    const stars = rankTier % 10;
    if (tier >= 8 || stars <= 0) return undefined;
    return `https://www.opendota.com/assets/images/dota2/rank_icons/rank_star_${stars}.png`;
}

export async function renderScoreboardFromMatch(
    match: any,
    focusSteamIds: string[] = [],
    rankDisplay?: MatchRankDisplay | null,
): Promise<Buffer> {
    const focus = new Set(focusSteamIds.map(String));
    const ranks = rankDisplay === undefined ? await resolveMatchRankDisplay(match) : rankDisplay;
    const toPlayer = async (p: any): Promise<ScoreboardPlayer> => {
        const hero = await dotaDataService.getHeroName(p.hero_id);
        const rank = ranks?.playersBySteamId.get(String(p.account_id || ''));
        return {
            heroName: hero,
            heroImageUrl: APIConstants.IMAGE_URL(hero),
            personaName: p.personaname || 'Anonymous',
            rankLabel: rank?.label,
            rankTier: rank?.rankTier,
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
    return renderMatchScoreboard(radiant, dire, {
        matchId: match.match_id,
        durationSec: match.duration,
        mode,
        lobbyRankLabel: ranks?.lobbyRankLabel,
        visibleRankCount: ranks?.visibleRankCount,
    });
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
    const W = 900;
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
        gpm: 555,
        dur: 635,
        rank: 710,
        mode: 810,
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
    ctx.fillText('AVG', cols.rank, colHeaderY);
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

        // Average visible lobby rank for this match, when the API exposes it.
        ctx.fillStyle = '#a5b4fc';
        ctx.fillText(truncatePx(ctx, r.rankLabel || '—', 82), cols.rank, ty);

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
    x: number;            // ranked-medal MMR
    y: number;            // hidden turbo estimate
    confidence: number;
    sampleSize?: number;
    partyFallback?: boolean;
    stale?: boolean;
    outlier?: boolean;
}

// Medal ladder shared by the turbo-study charts.
const STUDY_MEDALS = [
    { name: 'Herald', floor: 0, color: '#8a6d5a' },
    { name: 'Guardian', floor: 770, color: '#5f9e63' },
    { name: 'Crusader', floor: 1540, color: '#5a82a8' },
    { name: 'Archon', floor: 2310, color: '#9070b8' },
    { name: 'Legend', floor: 3080, color: '#d4b24a' },
    { name: 'Ancient', floor: 3850, color: '#cf7d36' },
    { name: 'Divine', floor: 4620, color: '#d65a6e' },
    { name: 'Immortal', floor: 5420, color: '#e6c84f' },
];
const STUDY_TOP_MMR = 6000;

function studyMedalColor(mmr: number): string {
    let c = STUDY_MEDALS[0].color;
    for (const m of STUDY_MEDALS) if (mmr >= m.floor) c = m.color;
    return c;
}

function studyPointColor(p: { partyFallback?: boolean; stale?: boolean; confidence: number }): string {
    return p.partyFallback ? '#ef4444' : p.stale ? '#f59e0b' : p.confidence < 50 ? '#94a3b8' : '#38bdf8';
}

function boxesOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function overlapArea(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
    const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return x * y;
}

function roundRectPath(ctx: any, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

export function renderTurboStudyScatter(
    points: TurboStudyPoint[],
    opts: { title: string; xLabel: string; yLabel: string; fit?: { slope: number; intercept: number } },
): Buffer {
    const W = 1120;
    const H = 680;
    const P = 88;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#0b1120';
    ctx.fillRect(0, 0, W, H);

    if (points.length < 2) {
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 20px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Not enough data', W / 2, H / 2);
        return canvas.toBuffer('image/png');
    }

    const maxVal = Math.max(...points.map((p) => Math.max(p.x, p.y)));
    const low = 0;
    const high = Math.ceil((maxVal + 350) / 500) * 500;
    const range = Math.max(1, high - low);
    const plotW = W - P * 2;
    const plotH = H - P * 2;
    const sx = (x: number) => P + ((x - low) / range) * plotW;
    const sy = (y: number) => H - P - ((y - low) / range) * plotH;

    ctx.fillStyle = '#111827';
    ctx.fillRect(P, P, plotW, plotH);
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(P, P, plotW, plotH);

    // Grid + axis ticks.
    ctx.font = '12px sans-serif';
    for (let v = low; v <= high; v += 500) {
        const x = sx(v);
        const y = sy(v);
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, P); ctx.lineTo(x, H - P); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(P, y); ctx.lineTo(W - P, y); ctx.stroke();
        ctx.fillStyle = '#cbd5e1';
        ctx.textAlign = 'center';
        ctx.fillText(String(v), x, H - P + 20);
        ctx.textAlign = 'right';
        ctx.fillText(String(v), P - 8, y + 4);
    }

    // Identity line (perfect agreement).
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath(); ctx.moveTo(sx(low), sy(low)); ctx.lineTo(sx(high), sy(high)); ctx.stroke();
    ctx.setLineDash([]);

    // Regression fit line.
    if (opts.fit) {
        const y0 = opts.fit.slope * low + opts.fit.intercept;
        const y1 = opts.fit.slope * high + opts.fit.intercept;
        ctx.strokeStyle = '#22d3ee';
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(sx(low), sy(y0)); ctx.lineTo(sx(high), sy(y1)); ctx.stroke();
    }

    // Points: radius by sample size, colour by status, red ring for outliers.
    const renderedPoints: Array<TurboStudyPoint & { px: number; py: number; radius: number }> = [];
    for (const point of points) {
        const x = sx(point.x);
        const y = sy(point.y);
        const radius = 5 + Math.min(7, Math.sqrt(Math.max(0, point.sampleSize ?? 0)));
        renderedPoints.push({ ...point, px: x, py: y, radius });
        if (point.outlier) {
            ctx.beginPath(); ctx.arc(x, y, radius + 4, 0, Math.PI * 2);
            ctx.strokeStyle = '#f87171'; ctx.lineWidth = 2; ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = studyPointColor(point); ctx.fill();
        ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 1.5; ctx.stroke();
    }

    // Label every player. Try several offsets and keep labels inside the plot area.
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    const labelOffsets = [
        [12, -18], [12, 10], [-92, -18], [-92, 10],
        [26, -34], [26, 28], [-112, -34], [-112, 28],
        [0, -46], [0, 42],
    ];
    ctx.font = '11px sans-serif';
    for (const point of renderedPoints.sort((a, b) => Number(b.outlier) - Number(a.outlier))) {
        const text = point.label;
        const w = Math.min(180, Math.ceil(ctx.measureText(text).width) + 10);
        const h = 18;
        let best = { x: point.px + point.radius + 8, y: point.py - 13, w, h };
        let bestScore = Infinity;

        for (const [dx, dy] of labelOffsets) {
            const x = Math.max(P + 4, Math.min(W - P - w - 4, point.px + dx));
            const y = Math.max(P + 4, Math.min(H - P - h - 4, point.py + dy));
            const box = { x, y, w, h };
            const overlap = placed.reduce((sum, p) => sum + overlapArea(box, p), 0);
            const distance = Math.hypot((x + w / 2) - point.px, (y + h / 2) - point.py);
            const score = overlap * 1000 + distance;
            if (!placed.some((p) => boxesOverlap(box, p))) {
                best = box;
                bestScore = score;
                break;
            }
            if (score < bestScore) {
                best = box;
                bestScore = score;
            }
        }

        placed.push(best);
        ctx.strokeStyle = '#64748b99';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(point.px, point.py);
        ctx.lineTo(best.x + best.w / 2, best.y + best.h / 2);
        ctx.stroke();

        ctx.fillStyle = '#020617dd';
        roundRectPath(ctx, best.x, best.y, best.w, best.h, 4);
        ctx.fill();
        ctx.strokeStyle = point.outlier ? '#f87171' : '#475569';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#f8fafc';
        ctx.textAlign = 'left';
        ctx.fillText(text, best.x + 5, best.y + 13, best.w - 10);
    }

    // Title + axis labels.
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 21px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(opts.title, W / 2, 32);
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(opts.xLabel, W / 2, H - 18);
    ctx.save(); ctx.translate(20, H / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText(opts.yLabel, 0, 0); ctx.restore();

    // Legend row.
    let lx = P; const ly = 50;
    ctx.textAlign = 'left'; ctx.font = '12px sans-serif';
    const legendLine = (color: string, dashed: boolean, label: string) => {
        ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.setLineDash(dashed ? [6, 4] : []);
        ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 18, ly); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#cbd5e1'; ctx.fillText(label, lx + 24, ly + 4); lx += 30 + ctx.measureText(label).width + 16;
    };
    const legendDot = (color: string, label: string) => {
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(lx + 5, ly, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#cbd5e1'; ctx.fillText(label, lx + 14, ly + 4); lx += 14 + ctx.measureText(label).width + 16;
    };
    legendLine('#e2e8f0', true, 'perfect agreement');
    if (opts.fit) legendLine('#22d3ee', false, 'least-squares fit');
    legendDot('#38bdf8', 'normal');
    legendDot('#94a3b8', 'low confidence');
    legendDot('#ef4444', 'party fallback');
    ctx.fillStyle = '#94a3b8'; ctx.fillText('point size = solo games; red ring = >=900 MMR gap', lx, ly + 4);

    return canvas.toBuffer('image/png');
}

/** Bias/residual plot: gap (turbo − ranked) vs ranked MMR, with a zero line and trend line. */
export function renderTurboStudyResidual(
    points: Array<{ label: string; rankedMMR: number; gap: number; confidence: number; partyFallback?: boolean; stale?: boolean }>,
    fit: { slope: number; intercept: number } | null,
): Buffer {
    const W = 980, H = 420, P = 70;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f8fafc'; ctx.fillRect(0, 0, W, H);

    if (points.length < 2) {
        ctx.fillStyle = '#111827'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Not enough data', W / 2, H / 2); return canvas.toBuffer('image/png');
    }

    const maxX = Math.ceil((Math.max(...points.map((p) => p.rankedMMR)) + 350) / 500) * 500;
    const maxAbs = Math.max(600, ...points.map((p) => Math.abs(p.gap)));
    const yTop = Math.ceil((maxAbs + 150) / 250) * 250;
    const plotW = W - P * 2, plotH = H - P * 2;
    const sx = (x: number) => P + (x / Math.max(1, maxX)) * plotW;
    const sy = (g: number) => P + plotH / 2 - (g / yTop) * (plotH / 2);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(P, P, plotW, plotH);
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(P, P, plotW, plotH);

    // Grid.
    ctx.font = '12px sans-serif';
    for (let g = -yTop; g <= yTop; g += 250) {
        const y = sy(g);
        ctx.strokeStyle = g === 0 ? '#334155' : '#e5e7eb';
        ctx.lineWidth = g === 0 ? 2 : 1;
        ctx.beginPath(); ctx.moveTo(P, y); ctx.lineTo(W - P, y); ctx.stroke();
        ctx.fillStyle = '#475569'; ctx.textAlign = 'right';
        ctx.fillText((g > 0 ? '+' : '') + g, P - 8, y + 4);
    }
    for (let v = 0; v <= maxX; v += 500) {
        const x = sx(v);
        ctx.strokeStyle = '#e5e7eb';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, P); ctx.lineTo(x, H - P); ctx.stroke();
        ctx.fillStyle = '#475569'; ctx.textAlign = 'center';
        ctx.fillText(String(v), x, H - P + 20);
    }

    // Practical outlier thresholds used by the study summary.
    for (const threshold of [-900, 900]) {
        if (Math.abs(threshold) > yTop) continue;
        const y = sy(threshold);
        ctx.strokeStyle = '#dc2626';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 5]);
        ctx.beginPath(); ctx.moveTo(P, y); ctx.lineTo(W - P, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#991b1b';
        ctx.textAlign = 'left';
        ctx.fillText(`${threshold > 0 ? '+' : ''}${threshold} outlier threshold`, P + 8, y - 5);
    }

    // Trend line of the gap itself (slope-1 minus identity already baked into fit).
    if (fit) {
        const g0 = (fit.slope * 0 + fit.intercept) - 0;
        const g1 = (fit.slope * maxX + fit.intercept) - maxX;
        ctx.strokeStyle = '#0891b2'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(sx(0), sy(g0)); ctx.lineTo(sx(maxX), sy(g1)); ctx.stroke();
    }

    for (const p of points) {
        const x = sx(p.rankedMMR), y = sy(p.gap);
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = studyPointColor(p); ctx.fill();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.3; ctx.stroke();
        if (Math.abs(p.gap) >= 700) {
            ctx.fillStyle = '#111827'; ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
            ctx.fillText(p.label.slice(0, 12), x + 9, y + 3);
        }
    }

    ctx.fillStyle = '#111827'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Estimate Bias — gap (Turbo − Ranked) vs Ranked', W / 2, 28);
    ctx.font = '13px sans-serif'; ctx.fillStyle = '#334155';
    ctx.fillText('Ranked medal estimate (MMR)', W / 2, H - 16);
    ctx.textAlign = 'left'; ctx.fillStyle = '#334155'; ctx.font = '11px sans-serif';
    ctx.fillText('positive = Turbo estimate above visible ranked medal', P + 6, P + 16);
    ctx.fillText('negative = Turbo estimate below visible ranked medal', P + 6, H - P - 8);

    return canvas.toBuffer('image/png');
}

/** Squad rank ladder: every calibrated player placed on the medal ladder by Turbo MMR. */
export function renderTurboLadder(
    players: Array<{ label: string; mmr: number; confidence: number; partyFallback?: boolean; stale?: boolean }>,
): Buffer {
    const W = 880;
    const rowTop = 64, rowBot = 60;
    const H = Math.max(360, rowTop + rowBot + STUDY_MEDALS.length * 44);
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#101019'; ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#fff'; ctx.font = 'bold 20px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Squad Turbo Rank Ladder', W / 2, 36);

    const laneX = 150, laneW = W - laneX - 40;
    const bandH = (H - rowTop - rowBot) / STUDY_MEDALS.length;

    // Draw medal bands high→low.
    const ordered = [...STUDY_MEDALS].reverse();
    for (let i = 0; i < ordered.length; i++) {
        const m = ordered[i];
        const y = rowTop + i * bandH;
        ctx.fillStyle = m.color + '22';
        roundRectPath(ctx, laneX, y + 3, laneW, bandH - 6, 8); ctx.fill();
        ctx.fillStyle = m.color; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'right';
        ctx.fillText(m.name, laneX - 12, y + bandH / 2 + 5);
    }

    const tierIndexFromTop = (mmr: number) => {
        let idx = 0;
        for (let i = 0; i < STUDY_MEDALS.length; i++) if (mmr >= STUDY_MEDALS[i].floor) idx = i;
        return STUDY_MEDALS.length - 1 - idx; // 0 = Immortal at top
    };

    // Group players by band, lay them out horizontally within their band.
    const byBand = new Map<number, typeof players>();
    for (const p of players) {
        const b = tierIndexFromTop(p.mmr);
        if (!byBand.has(b)) byBand.set(b, []);
        byBand.get(b)!.push(p);
    }
    for (const [b, group] of byBand) {
        group.sort((a, z) => z.mmr - a.mmr);
        const y = rowTop + b * bandH + bandH / 2;
        const slotW = laneW / Math.max(group.length, 1);
        for (let i = 0; i < group.length; i++) {
            const p = group[i];
            const x = laneX + slotW * (i + 0.5);
            const r = 8;
            ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fillStyle = studyPointColor(p); ctx.fill();
            ctx.strokeStyle = '#ffffffdd'; ctx.lineWidth = 1.5; ctx.stroke();
            ctx.fillStyle = '#e8e8f0'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText(p.label.slice(0, 12), x, y + r + 13);
        }
    }

    ctx.textAlign = 'left'; ctx.font = '11px sans-serif';
    ctx.fillStyle = '#a78bfa'; ctx.beginPath(); ctx.arc(laneX + 6, H - 28, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#c7c7d9'; ctx.fillText('solid estimate', laneX + 16, H - 24);
    ctx.fillStyle = '#9ca3af'; ctx.beginPath(); ctx.arc(laneX + 136, H - 28, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#c7c7d9'; ctx.fillText('low confidence', laneX + 146, H - 24);
    ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(laneX + 266, H - 28, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#c7c7d9'; ctx.fillText('party fallback', laneX + 276, H - 24);

    return canvas.toBuffer('image/png');
}

export interface HeroBalancePoint {
    label: string;
    rankedWR: number;   // 0..1
    turboWR: number;    // 0..1
    size: number;       // marker radius driver (e.g. sqrt of games)
    highlight?: boolean; // draw the hero's name (reserved for biggest movers)
}

/**
 * Ranked WR (x) vs Turbo WR (y) per hero, with a y=x agreement diagonal.
 * Dots above the line are turbo-favoured, below are turbo-suppressed; only
 * highlighted heroes get labels so the 100+ hero cloud stays readable.
 */
export function renderTurboHeroBalanceScatter(
    points: HeroBalancePoint[],
    opts: { title: string },
): Buffer {
    const W = 1120, H = 720, P = 88;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b1120'; ctx.fillRect(0, 0, W, H);

    if (points.length < 2) {
        ctx.fillStyle = '#fff'; ctx.font = 'bold 20px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Not enough data', W / 2, H / 2);
        return canvas.toBuffer('image/png');
    }

    // Auto-range around the data, snapped to whole percents, padded, clamped to [30,70].
    const all = points.flatMap((p) => [p.rankedWR * 100, p.turboWR * 100]);
    const low = Math.max(30, Math.floor((Math.min(...all) - 2)));
    const high = Math.min(70, Math.ceil((Math.max(...all) + 2)));
    const range = Math.max(1, high - low);
    const plotW = W - P * 2, plotH = H - P * 2;
    const sx = (v: number) => P + ((v - low) / range) * plotW;
    const sy = (v: number) => H - P - ((v - low) / range) * plotH;

    ctx.fillStyle = '#111827'; ctx.fillRect(P, P, plotW, plotH);
    ctx.strokeStyle = '#334155'; ctx.lineWidth = 1.5; ctx.strokeRect(P, P, plotW, plotH);

    // Grid + ticks every 5%.
    ctx.font = '12px sans-serif';
    const tickStart = Math.ceil(low / 5) * 5;
    for (let v = tickStart; v <= high; v += 5) {
        const x = sx(v), y = sy(v);
        ctx.strokeStyle = '#1f2937'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, P); ctx.lineTo(x, H - P); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(P, y); ctx.lineTo(W - P, y); ctx.stroke();
        ctx.fillStyle = '#cbd5e1'; ctx.textAlign = 'center';
        ctx.fillText(`${v}%`, x, H - P + 20);
        ctx.textAlign = 'right'; ctx.fillText(`${v}%`, P - 8, y + 4);
    }

    // 50% reference lines (true coin-flip).
    if (50 >= low && 50 <= high) {
        ctx.strokeStyle = '#475569'; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
        ctx.beginPath(); ctx.moveTo(sx(50), P); ctx.lineTo(sx(50), H - P); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(P, sy(50)); ctx.lineTo(W - P, sy(50)); ctx.stroke();
        ctx.setLineDash([]);
    }

    // y=x agreement diagonal (same WR in both modes).
    ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 2; ctx.setLineDash([8, 6]);
    ctx.beginPath(); ctx.moveTo(sx(low), sy(low)); ctx.lineTo(sx(high), sy(high)); ctx.stroke();
    ctx.setLineDash([]);

    // Dots: green above diagonal (turbo-favoured), red below.
    const rendered: Array<HeroBalancePoint & { px: number; py: number; r: number }> = [];
    for (const p of points) {
        const px = sx(p.rankedWR * 100), py = sy(p.turboWR * 100);
        const r = 4 + Math.min(8, Math.sqrt(Math.max(0, p.size)));
        rendered.push({ ...p, px, py, r });
        const fav = p.turboWR - p.rankedWR;
        ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fillStyle = fav >= 0 ? '#34d399cc' : '#f87171cc'; ctx.fill();
        ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 1; ctx.stroke();
    }

    // Label only highlighted (biggest-mover) heroes to keep the cloud legible.
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    const offsets = [[10, -16], [10, 8], [-90, -16], [-90, 8], [0, -28], [0, 24]];
    ctx.font = '12px sans-serif';
    for (const p of rendered.filter((q) => q.highlight)) {
        const w = Math.min(170, Math.ceil(ctx.measureText(p.label).width) + 10), h = 18;
        let best = { x: p.px + p.r + 6, y: p.py - 13, w, h }, bestScore = Infinity;
        for (const [dx, dy] of offsets) {
            const x = Math.max(P + 4, Math.min(W - P - w - 4, p.px + dx));
            const y = Math.max(P + 4, Math.min(H - P - h - 4, p.py + dy));
            const box = { x, y, w, h };
            if (!placed.some((q) => boxesOverlap(box, q))) { best = box; break; }
            const score = placed.reduce((s, q) => s + overlapArea(box, q), 0);
            if (score < bestScore) { best = box; bestScore = score; }
        }
        placed.push(best);
        ctx.strokeStyle = '#64748b99'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.px, p.py); ctx.lineTo(best.x + best.w / 2, best.y + best.h / 2); ctx.stroke();
        ctx.fillStyle = '#020617dd'; roundRectPath(ctx, best.x, best.y, best.w, best.h, 4); ctx.fill();
        ctx.strokeStyle = '#475569'; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = '#f8fafc'; ctx.textAlign = 'left';
        ctx.fillText(p.label, best.x + 5, best.y + 13, best.w - 10);
    }

    // Title + axis labels.
    ctx.fillStyle = '#f8fafc'; ctx.font = 'bold 21px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(opts.title, W / 2, 32);
    ctx.font = '13px sans-serif'; ctx.fillStyle = '#cbd5e1';
    ctx.fillText('Ranked win rate', W / 2, H - 18);
    ctx.save(); ctx.translate(20, H / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText('Turbo win rate', 0, 0); ctx.restore();

    // Legend.
    let lx = P; const ly = 52; ctx.textAlign = 'left'; ctx.font = '12px sans-serif';
    const dot = (color: string, label: string) => {
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(lx + 5, ly, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#cbd5e1'; ctx.fillText(label, lx + 14, ly + 4); lx += 14 + ctx.measureText(label).width + 18;
    };
    ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 3; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 18, ly); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#cbd5e1'; ctx.fillText('same WR (y=x)', lx + 24, ly + 4); lx += 30 + ctx.measureText('same WR (y=x)').width + 18;
    dot('#34d399', 'turbo-favoured');
    dot('#f87171', 'turbo-suppressed');
    ctx.fillStyle = '#94a3b8'; ctx.fillText('dot size = games played', lx, ly + 4);

    return canvas.toBuffer('image/png');
}
