// Static game data and constants. No logic, no DOM, no imports.

export const SIZE = 15, RACK = 7, BINGO = 50, MIN_BAG_SWAP = 7, CENTER = 7, PENALTY = 5;
export const DURATIONS = [10, 15, 25, 40, 60];
export const DEFAULT_MINUTES = 25;
export const DEFAULT_MODE = 'expanded';   // id of a profile in modes.js
// Chess-style clock: every move that puts tiles on the board adds this much to the mover's clock. A pass, a swap, a voided move and the move that ends the game add nothing.
export const INCREMENT_MS = 5000;
export const TOAST_MS = 4000, TICK_MS = 250;

// Premium squares: 1 DL, 2 TL, 3 DW, 4 TW, 5 center (DW)
const HALF = ['400100040001004','030002000200030','003000101000300','100300010003001','000030000030000','020002000200020','001000101000100','400100050001004'];
export const LAYOUT = [...HALF, ...HALF.slice(0, 7).reverse()].map(s => [...s].map(Number));

// Per-letter [x,y] offset in em so every glyph's ink is centred in the tile, above the value digit
export const GLYPH = {ء:[0.00,-0.26],آ:[0.03,0.06],أ:[-0.00,0.10],ؤ:[0.07,-0.19],إ:[-0.04,-0.18],ئ:[-0.01,-0.21],ا:[0.00,-0.04],ب:[0.01,-0.34],ة:[-0.00,-0.11],ت:[0.01,-0.16],ث:[0.01,-0.11],ج:[-0.07,-0.54],ح:[-0.07,-0.54],خ:[-0.07,-0.43],د:[0.01,-0.21],ذ:[0.01,-0.09],ر:[0.06,-0.38],ز:[0.06,-0.23],س:[-0.00,-0.33],ش:[-0.00,-0.16],ص:[-0.00,-0.33],ض:[-0.00,-0.23],ط:[0.01,-0.05],ظ:[0.01,-0.05],ع:[-0.11,-0.40],غ:[-0.11,-0.32],ف:[-0.01,-0.05],ق:[0.01,-0.18],ك:[0.01,0.01],ل:[-0.01,-0.05],م:[0.01,-0.45],ن:[-0.01,-0.14],و:[0.07,-0.37],ى:[-0.01,-0.30],ي:[-0.01,-0.42],ه:[0.04,-0.21]};

// Letter shown on tiles / blank picker; game logic still uses plain ه
export const FACE = {'ه':'هـ'};

// Full text everywhere; the centre star is a word x2
export const LABEL = {1:'x2 حرف',2:'x3 حرف',3:'x2 كلمة',4:'x3 كلمة',5:'x2 كلمة'};

export const NAMES = ['اللاعب الأول', 'اللاعب الثاني'];
// ---------- How a game ends (the single source of truth; js/game.js endGame applies it, the Settings window states it) ----------
// A game ends in exactly two ways: (1) a player's clock reaches zero (any unsubmitted move is discarded), or (2) a player uses every tile once the bag is empty.
// Passing and swapping are unlimited and never end the game: a leader may keep passing to run the clock out. Word validity is decided by the players (tahkim), not a dictionary.
// Final score = score + TIME_BONUS_PER_MIN x (minutes left, rounded to the nearest minute; exactly :30 rounds down) - value of the tiles still on the rack.
export const TIME_BONUS_PER_MIN = 2;
// The reason line names the player it concerns; the argument is that player's name already escaped as HTML (see names.js nameHtml).
export const REASONS = {time: n => `انتهى وقت ${n}`, rack: n => `أنهى ${n} جميع قطعه`,
  // Online only: the player the reason names is the one who lost the match.
  resign: n => `استسلم ${n} وصارت نقاطه صفرًا`, abandon: n => `انقطع اتصال ${n} وانتهت مهلة العودة`};

// ---------- Online play (shared by the browser and the Edge Function) ----------
// A player who is being waited for (their turn, or the Tahkim ruling they asked for) and has been silent for ABANDON_MS may be claimed as the loser
// by the other player. Silence is measured by the SERVER (last_seen_at, refreshed by every action and by a heartbeat every HEARTBEAT_MS while the page is visible).
export const HEARTBEAT_MS = 20000;
export const ABANDON_MS = 300000;   // 5 min (was 3): a phone that was put down or switched to another app must not forfeit the match too easily

// Pause (online only): either player may stop both clocks. It is limited so it cannot be used to think for free:
// each player gets PAUSES_EACH pauses per game, a pause lasts at most PAUSE_MS (the server lets either player resume after that), and the board and racks are hidden while it lasts.
export const PAUSE_MS = 180000;

// Tahkim (v5.5) is a shared discussion: when a player challenges a move, both players get one chat box, both clocks stop, and the match stays frozen until BOTH players
// independently choose the same final verdict (صحيح or خطأ). Nothing in it expires: there is no approval or ruling time limit, and the discussion survives refreshes and
// reconnections (it lives in the game row). The only ways out are an agreement, a surrender (resign), or the other player's explicit abandon claim after ABANDON_MS of silence.
export const TAHKIM_CHAT_MAX_MESSAGES = 200;   // the oldest messages are dropped beyond this (the dispute record itself is kept)
export const TAHKIM_CHAT_MAX_CHARS = 300;       // per message
export const TAHKIM_LOG_MAX = 60;               // resolved disputes kept in the match history record
export const PAUSES_EACH = 2;
