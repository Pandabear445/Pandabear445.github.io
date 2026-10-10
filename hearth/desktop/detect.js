// Finds the game you're playing and the song you're listening to, so Hearth can show it on your profile.
// Runs only while "Show the game / music" is on in Hearth (Settings → Games & music), every 20 seconds.
// Nothing leaves this computer except the game's name or Steam number and the song's title/artist/album.
//
//  - Steam games: Steam itself records which game is running (RunningAppID), on Windows, Mac and Linux.
//  - Other popular games: matched by their program name (list below).
//  - Music: the Spotify app (Windows: its window title; Mac: AppleScript), the Apple Music app on Mac,
//    and any player that supports Linux's media controls (via playerctl, if installed).
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Program name (lower case) → game name, for games that don't run through Steam.
const KNOWN = {
  'fortniteclient-win64-shipping.exe': 'Fortnite',
  'valorant-win64-shipping.exe': 'VALORANT',
  'league of legends.exe': 'League of Legends',
  'robloxplayerbeta.exe': 'Roblox',
  'minecraft.windows.exe': 'Minecraft',
  'genshinimpact.exe': 'Genshin Impact',
  'starrail.exe': 'Honkai: Star Rail',
  'zenlesszonezero.exe': 'Zenless Zone Zero',
  'overwatch.exe': 'Overwatch 2',
  'r5apex.exe': 'Apex Legends',
  'r5apex_dx12.exe': 'Apex Legends',
  'rocketleague.exe': 'Rocket League',
  'gta5.exe': 'Grand Theft Auto V',
  'gta5_enhanced.exe': 'Grand Theft Auto V',
  'wow.exe': 'World of Warcraft',
  'hearthstone.exe': 'Hearthstone',
  'diablo iv.exe': 'Diablo IV',
  'destiny2.exe': 'Destiny 2',
  'rainbowsix.exe': 'Tom Clancy’s Rainbow Six Siege',
  'rainbowsix_vulkan.exe': 'Tom Clancy’s Rainbow Six Siege',
  'marvel-win64-shipping.exe': 'Marvel Rivals',
  'tslgame.exe': 'PUBG: BATTLEGROUNDS',
  'escapefromtarkov.exe': 'Escape from Tarkov',
  'osu!.exe': 'osu!',
  'warframe.x64.exe': 'Warframe',
  'pathofexile.exe': 'Path of Exile',
  'pathofexile_x64.exe': 'Path of Exile',
  'cyberpunk2077.exe': 'Cyberpunk 2077',
  'witcher3.exe': 'The Witcher 3: Wild Hunt',
  'bg3.exe': 'Baldur’s Gate 3',
  'bg3_dx11.exe': 'Baldur’s Gate 3',
  'rdr2.exe': 'Red Dead Redemption 2',
  'ts4_x64.exe': 'The Sims 4',
  'eldenring.exe': 'ELDEN RING',
  'terraria.exe': 'Terraria',
  'stardew valley.exe': 'Stardew Valley',
  'among us.exe': 'Among Us',
  'helldivers2.exe': 'HELLDIVERS 2',
  'palworld-win64-shipping.exe': 'Palworld',
  'lethal company.exe': 'Lethal Company',
  'phasmophobia.exe': 'Phasmophobia',
  'deadbydaylight-win64-shipping.exe': 'Dead by Daylight',
  'rustclient.exe': 'Rust',
  'factorio.exe': 'Factorio',
  'valheim.exe': 'Valheim',
  'forzahorizon5.exe': 'Forza Horizon 5',
  'skyrimse.exe': 'The Elder Scrolls V: Skyrim',
  'fallout4.exe': 'Fallout 4',
  'starfield.exe': 'Starfield',
  'haloinfinite.exe': 'Halo Infinite',
  'sotgame.exe': 'Sea of Thieves',
  'brawlhalla.exe': 'Brawlhalla',
  'cs2.exe': 'Counter-Strike 2',
  'dota2.exe': 'Dota 2',
  // macOS / Linux process names
  'roblox': 'Roblox',
  'robloxplayer': 'Roblox',
  'league of legends': 'League of Legends',
  'factorio': 'Factorio',
  'terraria': 'Terraria',
  'stardew valley': 'Stardew Valley',
  'osu!': 'osu!',
  'among us': 'Among Us',
};

const run = (cmd, args, timeout = 8000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout)));
});

// ------------------------------------------------------------------ Steam
function steamRegistryFiles() {
  const home = os.homedir();
  return process.platform === 'darwin'
    ? [path.join(home, 'Library', 'Application Support', 'Steam', 'registry.vdf')]
    : [path.join(home, '.steam', 'registry.vdf'), path.join(home, '.steam', 'steam', 'registry.vdf'), path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.steam', 'registry.vdf')];
}
async function steamGame() {
  if (process.platform === 'win32') {
    const out = await run('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'RunningAppID']);
    const m = out.match(/RunningAppID\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    const id = m ? parseInt(m[1], 16) : 0;
    return id > 0 ? id : 0;
  }
  for (const f of steamRegistryFiles()) {
    try {
      const m = fs.readFileSync(f, 'utf8').match(/"RunningAppID"\s+"(\d+)"/i);
      if (m && +m[1] > 0) return +m[1];
    } catch { /* not there */ }
  }
  return 0;
}

// ------------------------------------------------------------------ running programs (+ window titles on Windows)
async function processes() {
  if (process.platform === 'win32') {
    // CSV: "Image Name","PID","Session Name","Session#","Mem Usage","Status","User Name","CPU Time","Window Title"
    const out = await run('tasklist', ['/v', '/fo', 'csv', '/nh'], 15000);
    return out.split(/\r?\n/).filter(Boolean).map((line) => {
      const cols = line.match(/"([^"]*)"/g) || [];
      const v = cols.map((c) => c.slice(1, -1));
      return { name: (v[0] || '').toLowerCase(), title: v[8] || '' };
    });
  }
  const out = await run('ps', ['-axco', 'comm']);
  return out.split('\n').slice(1).map((x) => ({ name: x.trim().toLowerCase(), title: '' })).filter((p) => p.name);
}

function knownGame(list) {
  for (const p of list) {
    if (KNOWN[p.name]) return KNOWN[p.name];
    // Minecraft (Java edition) runs inside Java; its window title says "Minecraft 1.21…".
    if ((p.name === 'javaw.exe' || p.name === 'java') && /^Minecraft[\s*]/.test(p.title)) return 'Minecraft';
  }
  return null;
}

// ------------------------------------------------------------------ music
async function music(list) {
  if (process.platform === 'win32') {
    // The Spotify app's window title is "Artist - Song" while playing ("Spotify …" when paused).
    const sp = list.find((p) => p.name === 'spotify.exe' && / - /.test(p.title) && !/^Spotify/i.test(p.title));
    if (sp) { const i = sp.title.indexOf(' - '); return { platform: 'spotify', artist: sp.title.slice(0, i), title: sp.title.slice(i + 3) }; }
    return null;
  }
  if (process.platform === 'darwin') {
    for (const [appName, platform] of [['Spotify', 'spotify'], ['Music', 'apple']]) {
      if (!list.some((p) => p.name === appName.toLowerCase())) continue; // never start the app by asking it
      const script = `tell application "${appName}" to if player state is playing then return (name of current track) & "\\n" & (artist of current track) & "\\n" & (album of current track)`;
      const out = (await run('osascript', ['-e', script], 4000)).trim();
      if (out) { const [title, artist, album] = out.split('\n'); return { platform, title, artist, album }; }
    }
    return null;
  }
  const out = await run('playerctl', ['-a', 'metadata', '--format', '{{status}}\t{{playerName}}\t{{title}}\t{{artist}}\t{{album}}'], 4000);
  for (const line of out.split('\n')) {
    const [status, player, title, artist, album] = line.split('\t');
    if (status === 'Playing' && title) return { platform: /spotify/i.test(player) ? 'spotify' : 'other', title, artist, album };
  }
  return null;
}

// ------------------------------------------------------------------ loop
let timer = null;
let busy = false;
function start(send, { games = true, songs = true } = {}) {
  stop();
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const list = (games || songs) ? await processes() : [];
      let game = null;
      if (games) {
        const steam = await steamGame();
        if (steam) game = { steamAppId: steam };
        else { const name = knownGame(list); if (name) game = { name }; }
      }
      const song = songs ? await music(list) : null;
      send({ game, music: song && song.title ? { title: song.title.slice(0, 120), artist: (song.artist || '').slice(0, 120), album: (song.album || '').slice(0, 120), platform: song.platform } : null });
    } catch { /* try again next time */ } finally { busy = false; }
  };
  setTimeout(tick, 3000);
  timer = setInterval(tick, 20000);
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { start, stop, KNOWN };
