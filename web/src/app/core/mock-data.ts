import type { Entry } from './models';

/**
 * Mock ROM collection, ported from prototype/data.js with folders baked in.
 * Used to build the full ux before the real scan → identify → status pipeline
 * is wired. The LibraryStore loads this until a real card is connected.
 */
export const MOCK_ENTRIES: Entry[] = [
  {
    id: 'smw', title: 'Super Mario World', file: 'Super Mario World (USA).sfc', folder: 'SNES',
    system: 'SNES', crc: 'B19ED489', size: 524288, cover: 'has', cheats: 'has', save: true, matched: true,
    c1: '#2b6fe0', c2: '#0b2a66',
    cheatList: [
      { name: 'Infinite lives', on: true },
      { name: 'Always have Cape', on: true },
      { name: 'Invincibility', on: false },
      { name: 'Walk through walls', on: false },
      { name: 'Infinite time', on: false },
    ],
  },
  {
    id: 'bsx-zelda', title: 'BS Zelda no Densetsu', file: 'BS Zelda no Densetsu (Japan).bs', folder: '_BSX',
    system: 'BSX', crc: 'A1B2C3D4', size: 1048576, cover: 'has', cheats: 'none', save: true, matched: true,
    c1: '#d08a2b', c2: '#5a3a0b',
  },
  {
    id: 'smb', title: 'Super Mario Bros.', file: 'Super Mario Bros. (World).nes', folder: 'NES',
    system: 'NES', crc: 'D445F698', size: 40976, cover: 'available', cheats: 'none', save: false, matched: true,
    c1: '#d13b27', c2: '#4a0f0a',
  },
  {
    id: 'sonic-sms', title: 'Sonic the Hedgehog', file: 'Sonic the Hedgehog (USA, Europe).sms', folder: 'SMS',
    system: 'SMS', crc: 'B519E833', size: 262144, cover: 'available', cheats: 'none', save: false, matched: true,
    c1: '#1f6fd0', c2: '#0a2a5a',
  },
  {
    id: 'pitfall-a26', title: 'Pitfall!', file: 'Pitfall! (USA).a26', folder: 'ATARI',
    system: 'A26', crc: '3E90CF23', size: 4096, cover: 'available', cheats: 'none', save: false, matched: true,
    c1: '#c8641e', c2: '#4a2208',
  },
  {
    id: 'sdgg-axis-st', title: 'SD Gundam Generation - Axis Senki', file: 'SD Gundam Generation - Axis Senki (Japan).st', folder: 'SUFAMI',
    system: 'ST', crc: '72B4235F', size: 524288, cover: 'available', cheats: 'none', save: true, matched: true,
    c1: '#8b5cf6', c2: '#2e1a5a',
  },
  {
    id: 'alttp', title: 'Legend of Zelda, The - A Link to the Past', file: 'Zelda - A Link to the Past (USA).sfc', folder: 'SNES',
    system: 'SNES', crc: '777AAC2F', size: 1048576, cover: 'has', cheats: 'has', save: true, matched: true,
    c1: '#1f8a5b', c2: '#0a3a26',
    cheatList: [
      { name: 'Infinite health', on: true },
      { name: 'Infinite magic', on: true },
      { name: 'Infinite rupees', on: false },
      { name: 'Infinite bombs', on: false },
      { name: 'Have Master Sword', on: false },
    ],
  },
  {
    id: 'metroid', title: 'Super Metroid', file: 'Super Metroid (Japan, USA) (En,Ja).sfc', folder: 'SNES',
    system: 'SNES', crc: 'D63ED5F8', size: 3145728, cover: 'has', cheats: 'available', save: true, matched: true,
    c1: '#c2410c', c2: '#3a160a',
  },
  {
    id: 'chrono', title: 'Chrono Trigger', file: 'Chrono Trigger (USA).sfc', folder: 'SNES/RPG',
    system: 'SNES', crc: '2D206BF7', size: 4194304, cover: 'available', cheats: 'available', save: false, matched: true,
    c1: '#7c3aed', c2: '#2a134f',
  },
  {
    id: 'dkc', title: 'Donkey Kong Country', file: 'DKC.sfc', folder: 'SNES',
    system: 'SNES', crc: '36B1F1F0', size: 4194304, cover: 'has', cheats: 'has', save: true, matched: true,
    c1: '#a16207', c2: '#3a2606',
    cheatList: [
      { name: 'Infinite lives', on: true },
      { name: 'Keep Diddy & Donkey', on: false },
      { name: '50 bananas always', on: false },
    ],
  },
  {
    id: 'ff6', title: 'Final Fantasy III', file: 'Final Fantasy III (USA).sfc', folder: 'SNES/RPG',
    system: 'SNES', crc: 'C0FA0464', size: 3145728, cover: 'has', cheats: 'available', save: true, matched: true,
    c1: '#0e7490', c2: '#06303a',
  },
  {
    id: 'smk', title: 'Super Mario Kart', file: 'smk (u).smc', folder: 'SNES',
    system: 'SNES', crc: '8C8A6720', size: 524288, cover: 'has', cheats: 'none', save: true, matched: true,
    c1: '#dc2626', c2: '#3a0a0a',
  },
  {
    id: 'starfox', title: 'Star Fox', file: 'Star Fox (USA).sfc', folder: 'SNES',
    system: 'SNES', crc: '8F88B5BE', size: 1048576, cover: 'available', cheats: 'none', save: false, matched: true,
    c1: '#1d4ed8', c2: '#0a1f4f',
  },
  {
    id: 'mmx', title: 'Mega Man X', file: 'Mega Man X (USA).sfc', folder: 'SNES',
    system: 'SNES', crc: '7E6FB1D2', size: 1572864, cover: 'has', cheats: 'has', save: true, matched: true,
    c1: '#2563eb', c2: '#0a1f4f',
    cheatList: [
      { name: 'Infinite health', on: true },
      { name: 'Infinite lives', on: true },
      { name: 'All weapons', on: false },
      { name: 'Have all armor parts', on: false },
    ],
  },
  {
    id: 'earthbound', title: 'EarthBound', file: 'EarthBound (USA).sfc', folder: 'SNES/RPG',
    system: 'SNES', crc: '6321D5F0', size: 3145728, cover: 'has', cheats: 'available', save: true, matched: true,
    c1: '#ca8a04', c2: '#3a2a06',
  },
  {
    id: 'fzero', title: 'F-Zero', file: 'F-Zero (USA).sfc', folder: 'SNES',
    system: 'SNES', crc: 'B25B7DDF', size: 524288, cover: 'has', cheats: 'none', save: false, matched: true,
    c1: '#9333ea', c2: '#2a134f',
  },
  {
    id: 'smrpg', title: 'Super Mario RPG - Legend of the Seven Stars', file: 'Super Mario RPG (USA).sfc', folder: 'SNES/RPG',
    system: 'SNES', crc: '99383B22', size: 4194304, cover: 'available', cheats: 'available', save: false, matched: true,
    c1: '#e11d48', c2: '#3a0a1a',
  },
  {
    id: 'mana', title: 'Secret of Mana', file: 'Secret of Mana (USA).sfc', folder: 'SNES/RPG',
    system: 'SNES', crc: '8C4D14B5', size: 1048576, cover: 'has', cheats: 'has', save: true, matched: true,
    c1: '#0891b2', c2: '#06303a',
    cheatList: [
      { name: 'Infinite HP (all)', on: true },
      { name: 'Infinite MP (all)', on: false },
      { name: 'Max GP', on: false },
    ],
  },
  {
    id: 'kirby', title: 'Kirby Super Star', file: 'Kirby Super Star (USA).sfc', folder: 'SNES',
    system: 'SNES', crc: '38C2DB16', size: 4194304, cover: 'has', cheats: 'none', save: true, matched: true,
    c1: '#db2777', c2: '#3a0a24',
  },
  {
    id: 'contra3', title: 'Contra III - The Alien Wars', file: 'Contra 3.sfc', folder: 'SNES',
    system: 'SNES', crc: 'AB60A39E', size: 1572864, cover: 'has', cheats: 'has', save: false, matched: true,
    c1: '#b91c1c', c2: '#3a0a0a',
    cheatList: [
      { name: 'Infinite lives', on: true },
      { name: 'Infinite continues', on: true },
      { name: 'Keep weapon on death', on: false },
    ],
  },
  {
    id: 'sf2', title: 'Super Street Fighter II - The New Challengers', file: 'Super Street Fighter II (USA).sfc', folder: 'SNES',
    system: 'SNES', crc: 'C9C42115', size: 4194304, cover: 'has', cheats: 'none', save: true, matched: true,
    c1: '#ea580c', c2: '#3a160a',
  },
  {
    id: 'yoshi', title: "Super Mario World 2 - Yoshi's Island", file: "Yoshi's Island.sfc", folder: 'SNES',
    system: 'SNES', crc: '4C1A4E1E', size: 4194304, cover: 'available', cheats: 'available', save: true, matched: true,
    c1: '#16a34a', c2: '#0a3a1a',
  },
  {
    id: 'tetris', title: 'Tetris', file: 'Tetris (World) (Rev A).gb', folder: 'Game Boy',
    system: 'GB', crc: '46DB5C79', size: 32768, cover: 'has', cheats: 'none', save: false, matched: true,
    c1: '#6b7280', c2: '#1f2937',
  },
  {
    id: 'pkred', title: 'Pokemon - Red Version', file: 'Pokemon Red.gb', folder: 'Game Boy',
    system: 'GB', crc: '9F7FDD53', size: 1048576, cover: 'available', cheats: 'available', save: true, matched: true,
    c1: '#dc2626', c2: '#3a0a0a',
  },
  {
    id: 'unknown', title: 'Super Kaizo World (hack).sfc', file: 'Super Kaizo World (hack).sfc', folder: 'Hacks',
    system: 'SNES', crc: '0A1B2C3D', size: 524288, cover: 'none', cheats: 'none', save: false, matched: false,
    c1: '#3f3f46', c2: '#18181b',
  },
];
