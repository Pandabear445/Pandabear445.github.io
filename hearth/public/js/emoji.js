// Emoji grouped by category, each with search keywords. "Frequently used" is tracked per device.
const RAW = {
  Smileys: '😀 grin smile happy|😃 smiley happy|😄 smile happy joy|😁 beam grin|😆 laugh squint|😅 sweat smile relief|🤣 rofl rolling laugh|😂 joy tears laugh lol|🙂 slight smile|🙃 upside down|😉 wink|😊 blush smile|😇 angel halo innocent|🥰 love hearts adore|😍 heart eyes love|🤩 star struck wow|😘 kiss blow|😗 kiss|😋 yum tasty|😛 tongue|😜 wink tongue crazy|🤪 zany crazy goofy|😝 squint tongue|🤑 money rich|🤗 hug|🤭 oops giggle|🤫 shush quiet secret|🤔 think hmm|🤐 zip mouth|🤨 raised eyebrow sus|😐 neutral meh|😑 expressionless|😶 no mouth silent|😏 smirk|😒 unamused|🙄 eye roll|😬 grimace awkward|😮‍💨 exhale sigh|🤥 lie pinocchio|😌 relieved calm|😔 pensive sad|😪 sleepy|🤤 drool|😴 sleep zzz|😷 mask sick|🤒 thermometer sick|🤕 hurt bandage|🤢 nauseous green|🤮 vomit sick|🥵 hot sweat|🥶 cold freeze|🥴 woozy dizzy|😵 dizzy|🤯 mind blown explode|🤠 cowboy|🥳 party celebrate|😎 cool sunglasses|🤓 nerd geek|🧐 monocle curious|😕 confused|😟 worried|🙁 frown|😮 open mouth surprised wow|😯 hushed|😲 astonished shock|😳 flushed embarrassed|🥺 pleading puppy eyes|😦 frown open|😧 anguished|😨 fearful scared|😰 anxious sweat|😥 sad relieved|😢 cry tear sad|😭 sob crying|😱 scream fear|😖 confounded|😣 persevere|😞 disappointed|😓 downcast sweat|😩 weary|😫 tired|🥱 yawn bored|😤 triumph huff|😡 angry rage|😠 mad angry|🤬 swear cursing|😈 devil smiling|👿 imp angry|💀 skull dead|☠️ skull crossbones|💩 poop|🤡 clown|👻 ghost boo|👽 alien|🤖 robot bot',
  People: '👋 wave hello hi bye|🤚 raised back hand|✋ hand stop high five|🖖 vulcan spock|👌 ok perfect|🤌 pinched italian|✌️ peace victory|🤞 fingers crossed luck|🤟 love you|🤘 rock horns metal|🤙 call me shaka|👈 point left|👉 point right|👆 point up|👇 point down|☝️ index up|👍 thumbs up like yes +1|👎 thumbs down dislike no -1|✊ fist raised|👊 punch fist bump|🤛 left fist|🤜 right fist|👏 clap applause|🙌 raise hands hooray|👐 open hands|🤲 palms up|🤝 handshake deal|🙏 pray please thanks|✍️ writing|💪 muscle strong flex|🧠 brain smart|👀 eyes look see|👁️ eye|👅 tongue|👄 mouth lips|💋 kiss lips|👶 baby|🧒 child kid|👦 boy|👧 girl|🧑 person adult|👨 man|👩 woman|🧓 older person|👴 old man|👵 old woman|🙋 raising hand|🙇 bow|🤦 facepalm|🤷 shrug idk|👮 police|🕵️ detective|💂 guard|👷 construction worker|🤴 prince|👸 princess|🧙 mage wizard|🧛 vampire|🧟 zombie|🧞 genie|🧜 merperson|🧚 fairy|🏃 run running|💃 dance dancer|🕺 dance man|🧘 yoga meditate|🛌 sleeping bed|👫 couple|💑 couple love|👪 family',
  Animals: '🐶 dog puppy|🐱 cat kitty|🐭 mouse|🐹 hamster|🐰 rabbit bunny|🦊 fox|🐻 bear|🐼 panda|🐨 koala|🐯 tiger|🦁 lion|🐮 cow|🐷 pig|🐸 frog|🐵 monkey|🙈 see no evil monkey|🙉 hear no evil|🙊 speak no evil|🐔 chicken|🐧 penguin|🐦 bird|🐤 chick|🦆 duck|🦅 eagle|🦉 owl|🦇 bat|🐺 wolf|🐗 boar|🐴 horse|🦄 unicorn|🐝 bee honey|🐛 bug|🦋 butterfly|🐌 snail|🐞 ladybug|🐜 ant|🕷️ spider|🦂 scorpion|🐢 turtle|🐍 snake|🦎 lizard|🦖 t-rex dinosaur|🦕 dinosaur|🐙 octopus|🦑 squid|🦐 shrimp|🦀 crab|🐡 blowfish|🐠 tropical fish|🐟 fish|🐬 dolphin|🐳 whale|🦈 shark|🐊 crocodile|🐅 tiger|🐘 elephant|🦒 giraffe|🦘 kangaroo|🐕 dog|🐈 cat|🐇 rabbit|🦝 raccoon|🦦 otter|🐿️ chipmunk squirrel|🦔 hedgehog|🌵 cactus|🌲 tree evergreen|🌳 tree|🌴 palm tree|🌱 seedling plant|🌿 herb|🍀 four leaf clover luck|🍁 maple leaf|🍄 mushroom|🌷 tulip|🌹 rose|🌻 sunflower|🌸 cherry blossom|🌞 sun face|🌝 moon face|⭐ star|🌟 glowing star|✨ sparkles|⚡ lightning zap|🔥 fire lit hot|🌈 rainbow|☀️ sun|⛅ cloud sun|🌧️ rain|❄️ snowflake snow|☃️ snowman|🌊 wave ocean|💧 droplet water',
  Food: '🍏 green apple|🍎 apple red|🍐 pear|🍊 orange tangerine|🍋 lemon|🍌 banana|🍉 watermelon|🍇 grapes|🍓 strawberry|🫐 blueberries|🍒 cherries|🍑 peach|🥭 mango|🍍 pineapple|🥥 coconut|🥝 kiwi|🍅 tomato|🥑 avocado|🍆 eggplant|🥔 potato|🥕 carrot|🌽 corn|🌶️ hot pepper spicy|🥒 cucumber|🥦 broccoli|🧄 garlic|🧅 onion|🥐 croissant|🍞 bread|🥖 baguette|🧀 cheese|🥚 egg|🍳 cooking egg|🥞 pancakes|🧇 waffle|🥓 bacon|🍗 chicken leg|🍖 meat|🌭 hot dog|🍔 burger hamburger|🍟 fries|🍕 pizza|🥪 sandwich|🌮 taco|🌯 burrito|🥗 salad|🍝 spaghetti pasta|🍜 ramen noodles|🍲 stew|🍛 curry|🍣 sushi|🍱 bento|🥟 dumpling|🍤 shrimp tempura|🍙 rice ball|🍚 rice|🍦 ice cream|🍩 donut doughnut|🍪 cookie|🎂 birthday cake|🍰 cake slice|🧁 cupcake|🍫 chocolate|🍬 candy|🍭 lollipop|🍿 popcorn|☕ coffee|🍵 tea|🧋 boba bubble tea|🥤 soda cup|🍺 beer|🍻 cheers beers|🥂 champagne toast|🍷 wine|🥃 whiskey|🍸 cocktail|🍹 tropical drink|🧃 juice|🥛 milk|🧊 ice',
  Activities: '⚽ soccer football|🏀 basketball|🏈 american football|⚾ baseball|🎾 tennis|🏐 volleyball|🏉 rugby|🎱 billiards 8 ball|🏓 ping pong|🏸 badminton|🏒 hockey|⛳ golf|🏹 archery bow|🎣 fishing|🥊 boxing|🥋 martial arts|⛸️ ice skate|🎿 ski|🛹 skateboard|🏆 trophy win|🥇 gold medal first|🥈 silver second|🥉 bronze third|🏅 medal|🎖️ military medal|🎫 ticket|🎪 circus|🎭 theater drama|🎨 art palette|🎬 movie clapper film|🎤 microphone sing karaoke|🎧 headphones music|🎼 score music|🎹 piano keyboard|🥁 drum|🎷 saxophone|🎺 trumpet|🎸 guitar|🎻 violin|🎲 dice game|♟️ chess|🎯 bullseye target|🎳 bowling|🎮 video game controller gaming|🕹️ joystick arcade|🧩 puzzle|🎰 slot machine|🎉 party popper tada celebrate|🎊 confetti|🎈 balloon|🎁 gift present|🎀 ribbon|🪅 piñata|🎃 jack o lantern halloween|🎄 christmas tree|🎆 fireworks|🎇 sparkler',
  Objects: '⌚ watch|📱 phone mobile|💻 laptop computer|⌨️ keyboard|🖥️ desktop computer|🖨️ printer|🖱️ mouse|💾 floppy save|💿 cd disc|📷 camera photo|📹 video camera|🎥 movie camera|📞 telephone|📺 tv television|📻 radio|🎙️ studio mic podcast|⏰ alarm clock|⌛ hourglass|📡 satellite|🔋 battery|🔌 plug|💡 bulb idea light|🔦 flashlight|🕯️ candle|🧯 extinguisher|💸 money wings|💵 dollar cash|💰 money bag|💳 credit card|💎 gem diamond|⚖️ scales|🔧 wrench|🔨 hammer|🛠️ tools|⛏️ pick|🔩 nut bolt|⚙️ gear settings|🧱 brick|⛓️ chains|🧲 magnet|🔫 water pistol|💣 bomb|🔪 knife|🗡️ dagger|⚔️ swords|🛡️ shield|🔮 crystal ball|🧿 nazar|💊 pill|💉 syringe|🧬 dna|🔬 microscope|🔭 telescope|🧹 broom|🧺 basket|🧻 toilet paper|🚽 toilet|🛁 bath|🔑 key|🗝️ old key|🚪 door|🛋️ couch|🛏️ bed|🧸 teddy bear|🖼️ frame picture|🛍️ shopping bags|🛒 cart|🎈 balloon|✉️ envelope mail|📦 package box|📮 mailbox|📝 memo note|📁 folder|📅 calendar|📌 pushpin pin|📎 paperclip|✂️ scissors|🖊️ pen|✏️ pencil|🔍 search magnifier|🔒 lock|🔓 unlock|🏠 house home|🏢 office building|🚗 car|🚀 rocket launch|✈️ airplane|🚲 bike|🗺️ map|🌍 earth globe world',
  Symbols: '❤️ red heart love|🧡 orange heart|💛 yellow heart|💚 green heart|💙 blue heart|💜 purple heart|🖤 black heart|🤍 white heart|🤎 brown heart|💔 broken heart|❣️ heart exclamation|💕 two hearts|💞 revolving hearts|💓 beating heart|💗 growing heart|💖 sparkling heart|💘 cupid arrow heart|💝 heart ribbon|💯 hundred 100 perfect|💢 anger|💥 boom collision|💫 dizzy star|💦 sweat drops|💨 dash|🕳️ hole|💬 speech bubble|💭 thought bubble|💤 zzz sleep|✅ check yes done|☑️ ballot check|✔️ check mark|❌ cross x no|❎ cross mark|➕ plus|➖ minus|➗ divide|✖️ multiply|❓ question|❔ white question|❗ exclamation|‼️ double exclamation|⁉️ interrobang|⚠️ warning|🚫 prohibited no|⛔ no entry|🔞 18|♻️ recycle|🔱 trident|📛 badge|🔰 beginner|⭕ circle|✳️ asterisk|❇️ sparkle|🆗 ok button|🆕 new|🆒 cool|🆓 free|🆙 up|🔴 red circle|🟠 orange circle|🟡 yellow circle|🟢 green circle|🔵 blue circle|🟣 purple circle|⚫ black circle|⚪ white circle|🔺 red triangle|🔻 down triangle|🔶 orange diamond|🔷 blue diamond|▶️ play|⏸️ pause|⏹️ stop|⏺️ record|⏭️ next|⏮️ previous|🔀 shuffle|🔁 repeat|🔔 bell|🔕 mute bell|🎵 music note|🎶 notes|➡️ right arrow|⬅️ left arrow|⬆️ up arrow|⬇️ down arrow|↩️ return|🔄 refresh|🏁 checkered flag|🚩 red flag|🏳️ white flag|🏴 black flag|🏳️‍🌈 rainbow flag pride',
};

export const EMOJI = {};
export const EMOJI_NAMES = new Map();
for (const [cat, list] of Object.entries(RAW)) {
  EMOJI[cat] = list.split('|').map((entry) => {
    const sp = entry.indexOf(' ');
    const e = entry.slice(0, sp);
    EMOJI_NAMES.set(e, entry.slice(sp + 1));
    return e;
  });
}
export const CATEGORY_ICONS = { Smileys: '😀', People: '👋', Animals: '🐶', Food: '🍕', Activities: '🎮', Objects: '💡', Symbols: '❤️' };
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

// "Frequently used": weighted by how often and how recently you picked each emoji.
export function recentEmoji() {
  try {
    const counts = JSON.parse(localStorage.getItem('hearth.emojiFreq') || '{}');
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 24).map(([e]) => e);
  } catch { return []; }
}
export function pushRecentEmoji(e) {
  let counts = {};
  try { counts = JSON.parse(localStorage.getItem('hearth.emojiFreq') || '{}'); } catch { /* ignore */ }
  for (const k of Object.keys(counts)) counts[k] *= 0.97;
  counts[e] = (counts[e] || 0) + 1;
  localStorage.setItem('hearth.emojiFreq', JSON.stringify(counts));
}
export function searchEmoji(q) {
  const t = q.trim().toLowerCase();
  if (!t) return [];
  const out = [];
  for (const [e, names] of EMOJI_NAMES) {
    const words = names.split(' ');
    if (words.some((w) => w.startsWith(t))) out.unshift(e);
    else if (names.includes(t)) out.push(e);
  }
  return [...new Set(out)].slice(0, 80);
}
