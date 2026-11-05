// The 30 Guess Who characters. Every character is a combination of traits; many share traits, none are identical.
// Run scripts/make-guesswho-art.js after changing anything here to re-render the portraits in assets/guesswho/.
const SKIN = { L: '#f3cfb3', T: '#dca67a', B: '#b07548', D: '#76472b' };
const HAIR = { black: '#1d1a19', brown: '#5b3a26', blonde: '#e2c06f', red: '#b4481d', grey: '#a2a2a8', none: null };
const EYES = { brown: '#4a2c17', blue: '#2f78d1', green: '#2f9a55' };

// name, skin, hairStyle, hairColor, eyes, glasses, hat, facial, earrings, mouth, shirt, background
const T = (name, skin, style, color, eyes, glasses, hat, facial, earrings, mouth, shirt, bg) =>
    ({ name, skin, style, color, eyes, glasses, hat, facial, earrings, mouth, shirt, bg });

const CHARACTERS = [
    T('Ava',   'L', 'long',     'blonde', 'blue',  'none',   'none',   'none',      false, 'smile',   '#2fa9a0', '#cfe8ff'),
    T('Ben',   'L', 'short',    'brown',  'brown', 'round',  'none',   'beard',     false, 'smile',   '#27406b', '#ffe6c7'),
    T('Cara',  'T', 'curly',    'black',  'brown', 'none',   'none',   'none',      true,  'smile',   '#e86fa0', '#e4f7d6'),
    T('Dan',   'L', 'short',    'red',    'green', 'none',   'cap',    'moustache', false, 'neutral', '#3a8f4b', '#fbe3e3'),
    T('Eli',   'D', 'bald',     'none',   'brown', 'square', 'none',   'beard',     false, 'neutral', '#6b6f76', '#ffeccc'),
    T('Fay',   'B', 'ponytail', 'black',  'brown', 'none',   'none',   'none',      true,  'smile',   '#8a5bd6', '#d9f1ff'),
    T('Gus',   'L', 'bald',     'none',   'blue',  'none',   'beanie', 'beard',     false, 'smile',   '#e6862e', '#e2f0d0'),
    T('Hana',  'T', 'bun',      'black',  'brown', 'round',  'none',   'none',      false, 'smile',   '#d6453d', '#fff1d1'),
    T('Ivan',  'L', 'mohawk',   'blonde', 'blue',  'none',   'none',   'none',      true,  'neutral', '#2a2a2e', '#dbe7ff'),
    T('Jade',  'D', 'curly',    'black',  'brown', 'none',   'none',   'none',      true,  'smile',   '#e8c230', '#f3dcf5'),
    T('Kai',   'T', 'short',    'black',  'brown', 'square', 'cap',    'none',      false, 'neutral', '#3567c9', '#fde7d3'),
    T('Lena',  'L', 'long',     'red',    'green', 'none',   'none',   'none',      false, 'smile',   '#3aa064', '#e6f4ff'),
    T('Milo',  'B', 'short',    'brown',  'brown', 'none',   'beanie', 'moustache', false, 'smile',   '#cf4a3e', '#e9f6dc'),
    T('Nina',  'L', 'bun',      'brown',  'blue',  'round',  'none',   'none',      true,  'smile',   '#b49ae6', '#fff0d6'),
    T('Omar',  'T', 'short',    'black',  'brown', 'none',   'none',   'beard',     false, 'neutral', '#26385f', '#fbe2e8'),
    T('Pia',   'B', 'long',     'black',  'brown', 'none',   'none',   'none',      false, 'smile',   '#ec8a33', '#dff3ee'),
    T('Quinn', 'L', 'ponytail', 'grey',   'blue',  'square', 'none',   'none',      false, 'neutral', '#7b7f87', '#ffe9d6'),
    T('Rex',   'D', 'mohawk',   'black',  'brown', 'none',   'none',   'none',      false, 'neutral', '#cc3b3b', '#e3e9ff'),
    T('Sara',  'T', 'long',     'brown',  'green', 'none',   'none',   'none',      true,  'smile',   '#2d9d95', '#fff3dc'),
    T('Theo',  'L', 'curly',    'blonde', 'blue',  'none',   'cap',    'none',      false, 'smile',   '#3d9b52', '#ffe3ea'),
    T('Uma',   'B', 'curly',    'black',  'brown', 'round',  'none',   'none',      false, 'smile',   '#e6709f', '#e1f5e5'),
    T('Vic',   'L', 'bald',     'none',   'green', 'none',   'none',   'moustache', false, 'neutral', '#2b2b2f', '#fdebd0'),
    T('Wes',   'T', 'short',    'brown',  'brown', 'none',   'cap',    'beard',     false, 'smile',   '#dd7f2c', '#e0ecff'),
    T('Xena',  'D', 'ponytail', 'black',  'brown', 'none',   'none',   'none',      true,  'smile',   '#8c5ad1', '#ffefd4'),
    T('Yara',  'L', 'short',    'grey',   'green', 'square', 'none',   'none',      false, 'neutral', '#3b6bbf', '#f6e1f1'),
    T('Zane',  'B', 'short',    'black',  'brown', 'none',   'beanie', 'none',      false, 'smile',   '#e7c331', '#dff0ff'),
    T('Alma',  'T', 'bun',      'red',    'green', 'none',   'none',   'none',      true,  'smile',   '#cf4036', '#e8f7de'),
    T('Bruno', 'L', 'short',    'grey',   'blue',  'round',  'none',   'moustache', false, 'neutral', '#7a5a3c', '#ffe8cf'),
    T('Cleo',  'D', 'long',     'black',  'brown', 'none',   'none',   'none',      true,  'smile',   '#2aa39a', '#fbe5ec'),
    T('Dex',   'T', 'mohawk',   'brown',  'green', 'none',   'none',   'beard',     false, 'neutral', '#6c7077', '#e5f0ff'),
];

// The things a person can have in common. A "feature" is a positive trait value: a hair style or colour,
// eye or skin colour, glasses, a hat, facial hair or earrings.
function features(c) {
    const f = [`skin:${c.skin}`, `eyes:${c.eyes}`, `mouth:${c.mouth}`, `hairstyle:${c.style}`];
    if (c.color !== 'none') f.push(`haircolor:${c.color}`);
    if (c.glasses !== 'none') f.push(`glasses:${c.glasses}`);
    if (c.hat !== 'none') f.push(`hat:${c.hat}`);
    if (c.facial !== 'none') f.push(`facial:${c.facial}`);
    if (c.earrings) f.push('earrings');
    return f;
}

module.exports = { CHARACTERS, SKIN, HAIR, EYES, features };
