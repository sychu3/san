import type { Card, GameState, PlayerId, PlayerState } from './types';
import { hasSkill } from './skills';

export function alivePlayers(state: GameState): PlayerState[] {
  return state.players.filter((player) => player.alive);
}

export function getPlayer(state: GameState, id: PlayerId): PlayerState {
  const player = state.players[id];
  if (!player) throw new Error(`Unknown player id: ${id}`);
  return player;
}

/** 以座位順序排列的存活角色。 */
export function aliveInSeatOrder(state: GameState): PlayerState[] {
  return state.players.filter((player) => player.alive);
}

export function seatDistance(state: GameState, from: PlayerId, to: PlayerId): number {
  if (from === to) return 0;
  const alive = aliveInSeatOrder(state);
  const fromIndex = alive.findIndex((player) => player.id === from);
  const toIndex = alive.findIndex((player) => player.id === to);
  if (fromIndex < 0 || toIndex < 0) return Number.POSITIVE_INFINITY;
  const n = alive.length;
  const clockwise = (toIndex - fromIndex + n) % n;
  const counter = (fromIndex - toIndex + n) % n;
  return Math.min(clockwise, counter);
}

/**
 * 角色之間的距離：座位距離 + 目標的 +1 馬 - 來源的 -1 馬，最少為 1。
 */
export function distance(state: GameState, from: PlayerId, to: PlayerId): number {
  const source = getPlayer(state, from);
  const target = getPlayer(state, to);
  let value = seatDistance(state, from, to);
  if (target.equips.horsePlus) value += 1;
  if (source.equips.horseMinus) value -= 1;
  if (hasSkill(source, 'mashu')) value -= 1;
  return Math.max(1, value);
}

export function attackRange(player: PlayerState): number {
  const weapon = player.equips.weapon;
  if (!weapon) return 1;
  return weaponRange(weapon);
}

export function weaponRange(weapon: Card): number {
  switch (weapon.name) {
    case 'crossbow':
      return 1;
    case 'double_sword':
    case 'qinggang':
    case 'ice_sword':
    case 'ancient_scimitar':
      return 2;
    case 'serpent_spear':
    case 'green_dragon':
    case 'rock_axe':
      return 3;
    case 'fan':
    case 'halberd':
      return 4;
    case 'qilin_bow':
      return 5;
    default:
      return 1;
  }
}

export function inAttackRange(state: GameState, from: PlayerId, to: PlayerId): boolean {
  if (from === to) return false;
  const source = getPlayer(state, from);
  const target = getPlayer(state, to);
  if (!source.alive || !target.alive) return false;
  return distance(state, from, to) <= attackRange(source);
}

export function handLimit(player: PlayerState): number {
  return Math.max(0, player.hp);
}

export function isWounded(player: PlayerState): boolean {
  return player.hp < player.maxHp;
}

export function isRed(card: Card): boolean {
  return card.suit === 'heart' || card.suit === 'diamond';
}

export function isBlack(card: Card): boolean {
  return card.suit === 'spade' || card.suit === 'club';
}

export function slashLimitReached(player: PlayerState): boolean {
  if (player.equips.weapon?.name === 'crossbow') return false;
  if (hasSkill(player, 'paoxiao')) return false;
  return player.slashUsed >= 1;
}

/** 由 start 開始的存活角色行動順序（含 start）。 */
export function turnOrderFrom(state: GameState, start: PlayerId): PlayerState[] {
  const alive = aliveInSeatOrder(state);
  const startIndex = alive.findIndex((player) => player.id === start);
  if (startIndex < 0) return [];
  return [...alive.slice(startIndex), ...alive.slice(0, startIndex)];
}

/** 下一個存活角色；若沒有其他存活角色則回傳自己。 */
export function nextAliveId(state: GameState, from: PlayerId): PlayerId {
  const count = state.players.length;
  if (count === 0) return from;
  const index = state.players.findIndex((player) => player.id === from);
  const start = index < 0 ? -1 : index;
  for (let offset = 1; offset <= count; offset += 1) {
    const candidate = state.players[(start + offset + count) % count];
    if (candidate?.alive) return candidate.id;
  }
  return from;
}

export function cardNameOf(card: Card): string {
  return card.name;
}
