# Accessibility, layout and UX consistency

This page covers what the web client does for keyboard, screen-reader and low-vision users, how it lays out from
phones to large screens, and the two browser suites that keep it that way. Paths are relative to `hearth/`.

## How to check

| Command | What it does | Time |
|---|---|---|
| `npm run test:a11y` | `test/a11y/run.mjs`: 127 checks in headless Chromium. It drives the real app on a fresh server: signs up, creates a server, sends messages, opens every main screen, dialog, menu and admin tab, and asserts the properties below. Exits non-zero on any failure. | about 3 min |
| `npm run test:visual` | `test/visual/run.mjs`: seven core screens at 1366×768 and 390×844, compared with baselines. | about 1 min |

Neither runs as part of `npm test` or CI. Both need Playwright and Chromium, which aren't Hearth dependencies.
`test/browser/harness.mjs` finds them in this order:
- `PLAYWRIGHT_MODULE` (the path to Playwright's `index.mjs`), then a global `playwright`;
- `CHROMIUM_PATH`, otherwise Playwright's own browser download.

On a machine without them, run `npm i -g playwright && npx playwright install chromium`.

### Visual baselines

Screenshots depend on the machine's fonts and graphics stack, so baselines aren't committed. They are made on the
machine that checks them:

1. **First run:** `npm run test:visual` writes `test/visual/baseline/*.png` (about 850 KB, git-ignored) and passes.
2. **Later runs:** each screen is compared with its baseline. A pixel counts as changed when a colour channel moves
   by more than 10 levels. A screen fails when more than 0.01% of its pixels changed. Repeated runs on one machine
   came out identical (0.000%). A 2 px change to the message box's corner radius was caught on 9 of 14 screens.
3. **When something changed:** `test/visual/output/` gets the new screenshot and a `.diff.png`, with changed pixels
   in magenta. If the change is intended, accept it with `npm run test:visual -- --update`.

Google Fonts requests are blocked during the run, so results don't depend on the network. Times, avatar colours
(made from random ids) and the time-of-day greeting are blanked by a test-only stylesheet. Masking alone wasn't
enough, because dialog backdrops blur what's behind them, smearing those colours past any mask.

## What the client guarantees

Each item is checked by `npm run test:a11y` unless marked otherwise.

### Dialogs (`modal()` in `public/js/ui.js`)
- `role="dialog"`, `aria-modal="true"`, and `aria-labelledby` pointing at the title. Dialogs without a visible
  title pass `label:` instead (Settings, Search).
- When a dialog opens, focus moves to its first field, or to the dialog itself so the title is read.
- Tab and Shift+Tab wrap inside the top dialog.
- Esc closes it, and focus returns to the control that opened it. That includes two-step flows: "Add a server",
  then "Create my own", then Esc returns to the "Add a server" button. It also includes a confirmation stacked on
  Settings: its Esc returns to the "Log out" button in Settings.
- `showError(box, message, input?)` shows an error and ties it to the field it's about. That's the given field,
  the focused one, or the dialog's only field. It uses `aria-invalid` and `aria-describedby` (`markInvalid` /
  `clearInvalid`). Editing the field clears the error state.
- The image viewer (`openViewer`) does the same: it traps Tab, closes on Esc and returns focus to the picture.
  Pictures in messages open with Enter or Space.

### Menus and popups (`popover()`, `menu()`, `contextMenu()`)
- Any `button` built with `data-pop-anchor` gets `aria-haspopup="true"` and `aria-expanded="false"` automatically
  (in `h()`). `popover()` sets `aria-expanded` to true while the popup is open and back to false when it closes.
- A `.menu` gets `role="menu"` and `menuitem` roles, even when it's built by hand like the status menu. Inside it:
  - ArrowUp and ArrowDown move between items, wrapping at the ends;
  - Home and End jump to the first and last item;
  - typing a letter jumps to the next item starting with it;
  - Tab closes the menu, like a native one.
- Other popups (emoji and GIF pickers, profile cards, the inbox) are non-modal dialogs. They're named after the
  button that opened them, take focus when they open and trap Tab.
- Esc closes any popup and puts focus back on its button. When the popup closes some other way while focus is
  inside it, focus also goes back to the button, so it's never dropped on the page.
- Admin tabs and the Security sub-tabs carry `aria-selected`. The emoji category buttons jump within one scrolling
  grid, so they're a `toolbar`, not tabs.

### Keyboard flow on the main screen
- The first Tab stop is **Skip to conversation** (`#skip-main`). It focuses the message box, or the main area
  when no conversation is open.
- Landmarks are `nav` (servers), `aside` (channels and conversations), `main` (`tabindex=-1`), and `aside`
  (members).
- **Messages** (`#messages` and threads, `role="log"`) use a roving tab stop:
  - only one message, plus its links and buttons, is in the Tab order;
  - ArrowUp, ArrowDown, Home and End move between messages, and the focused message shows its action toolbar;
  - before this change, Tab walked through every message's five toolbar buttons on the way to the message box.
  - The code is `roveMessage`, `setCurrentMessage`, `ensureCurrentMessage` and `messageListKeys` in `app.js`.
- Header redraws keep focus on the same button. "Show members" becomes "Hide members" without dropping focus.
- On phones, Esc closes the navigation drawer and returns focus to its button.

### Announcements
- `#toasts` is a polite live region (`role="status"`), so each toast is read once. Error toasts are `role="alert"`
  and stay up for 6 s instead of 3.8 s. Pointing at a toast holds it until the pointer leaves.
- The reconnecting banner (`#conn-banner`, `role="status"`) says "Reconnecting…" in words.

### Not colour alone
- Presence dots differ by shape as well as colour: a solid dot (online), a moon (idle), a bar (do not disturb) and
  a ring (offline or invisible). They carry the status as text (`role="img"`, `aria-label`), which is kept in sync
  when presence changes.
- Form errors are text, tied to their field. Key-change warnings use a shield icon plus a label.

### Labels
- The suite checks every visible interactive element on every screen it opens. Each needs an accessible name; it
  uses its own simplified accessible-name computation in `test/a11y/checks.mjs`.
- Every `img` has `alt`. Form fields have a label (`<label>`, `aria-label` or `aria-labelledby`); a placeholder
  alone doesn't count. No positive `tabindex`. No duplicate ids.
- Screens covered:
  - sign-in and sign-up;
  - home, a channel with messages, the message menu, emoji picker, status menu and search;
  - every Settings tab, including the instance "Server settings" tab;
  - every Server settings tab, plus the invite and create-channel dialogs;
  - profile card, friends, and every Admin tab.
- Fixed here: the download link, GIF key, backup count, IP block box, team username, test-email address, Terms
  editor, user search, member search in server settings, "What to follow" (news bot) and the new-owner picker.

### Focus visibility
- `:focus-visible` draws a 2 px outline in `--focus`. That's the accent colour, or a darker ink in the light theme,
  where the accent was 2:1 against the panels.
- Messages show the same ring inside their edge. Dialog and popup boxes, which take focus only to start reading,
  show none.

### Reduced motion
- `prefers-reduced-motion: reduce`, or Settings → Appearance → Reduce motion (`html.reduce-motion`), turns off
  animations and transitions (spinners excepted) and the profile effects layer (`.pfx`).
- Falling emoji on profile pages (`page.js`) and smooth scrolling also respect the setting.
- The suite checks that a toast's animation is ~0 s with the preference and non-zero without it.

### Colour contrast
`test/a11y/contrast.mjs` lets the browser resolve each theme token, which handles `var()`, RGB triplets and
`color-mix()`. It paints the token on a canvas and computes the WCAG 2.x ratio from the pixels. It checks 19 pairs
in each of the five themes (dark, midnight, dim, ember, light): 4.5:1 for text, 3:1 for the focus ring and status
dots. Before this work 22 of the 95 pairs failed; now all pass. The pairs that changed:

| Theme | Pair | Before | After | Needs |
|---|---|---|---|---|
| dark | muted text on the chat area / in menus | 4.27 / 4.46 | 4.75 / 4.95 | 4.5 |
| midnight | muted text on panels / chat / menus | 4.34 / 4.23 / 4.17 | 4.85 / 4.72 / 4.65 | 4.5 |
| dim | muted text on panels / chat / menus | 4.49 / 4.08 / 4.14 | 5.24 / 4.75 / 4.82 | 4.5 |
| ember | muted text on the chat area | 4.47 | 4.70 | 4.5 |
| light | muted text on panels / chat / menus | 3.90 / 4.33 / 4.33 | 4.75 / 5.27 / 5.27 | 4.5 |
| all | white text on red buttons and badges (new `--danger-fill`) | 3.43 | 4.92 | 4.5 |
| light | focus ring on the chat area / panels (new `--focus`) | 2.05 / 1.85 | 5.36 / 4.83 | 3 |
| light | online / idle / do-not-disturb / offline dots | 1.81 / 1.51 / 3.09 / 2.65 | 3.35 / 3.34 / 3.55 / 3.33 | 3 |

The token changes:
- `--muted` in every theme is a little lighter in the dark themes and darker in the light one.
- `--danger-fill: #d03449` is used behind white text; `--danger` stays bright for red text on dark panels.
- `--focus` is new.
- The light theme gets its own `--ok`, `--idle`, `--dnd` and `--offline`.

## Responsive layout

The suite checks four sizes: 390×844, 768×1024, 1366×768 and 1920×1080. It uses a channel with:
- a 24-character username;
- a 70-character server name;
- a 320-character URL;
- a 400-character unbroken word;
- an attachment with a 180-character name.

At every size there's no horizontal page scroll (`overflowDom` in `checks.mjs` also looks for any element sticking
out of the viewport). Message text, names and attachments stay inside the screen.

On a 390×844 touch phone:
- the settings button is reachable in the drawer;
- the message box and search are on screen;
- search opens full screen;
- settings fit and can be closed. The close button now has a solid background; before, it sat transparently on top
  of the scrolling tab names;
- in a voice channel, the call controls are on screen after joining.

**Mobile keyboard.** iOS Safari, and Chrome without an opt-in, don't resize the page when the on-screen keyboard
opens, so it covered the message box. Two changes handle this:
- `public/js/viewport.js` follows `visualViewport`: the app's height becomes the visible height (`--app-h`), and
  `html.kb-open` is set while the keyboard is up.
- The viewport meta tag adds `interactive-widget=resizes-content` for Chrome.

The suite fakes an iOS-style keyboard, where only `visualViewport` shrinks by 340 px. It checks that the message box
then sits above the keyboard, and that the app fills the screen again once the keyboard closes.

## Performance work that touches accessibility

`docs/PERFORMANCE.md` has the numbers. These parts were chosen to keep the app usable with a keyboard and screen
reader:
- Long member lists use `content-visibility: auto` instead of virtualization. Every row stays in the page, so
  screen readers, Tab and find-in-page reach all of them; off-screen rows just skip layout.
- The message history window keeps at most 300 messages loaded and drops the far end as you scroll. The roving tab
  stop is re-established when the current message is dropped, which the suite checks.

## Limits and what isn't verified

- **No manual screen-reader pass.** NVDA, JAWS, VoiceOver and TalkBack haven't been tried. The checks are automated
  DOM and ARIA assertions plus keyboard flows in Chromium. The accessible-name computation in `checks.mjs` is a
  simplification of the spec.
- **Coverage is limited to the screens the suite opens.** Pages it doesn't visit could still have unlabelled
  controls: profile pages and their editor, Recall, watch-together, events, polls, the activity picker and the
  cropper. Firefox and Safari aren't run.
- **Custom colours are the user's choice.** People can pick their own accent, name colours, server themes and
  profile-page colours. Contrast is checked only for the five built-in themes with the default accent. (Text on the
  accent does follow the accent's luminance; see `appearance.js`.)
- **The iOS keyboard is simulated** by faking `visualViewport`. It hasn't been tried on a real iPhone or Android
  device. The Electron and Android shells load the same web client but weren't tested here.
- **Some focus edge cases.** Hover cards and tooltips still need a pointer to show extra detail; the same text is
  in each control's label. Focus rings of controls inside member rows can be clipped at the row's edge by
  `content-visibility`.
- **Visual baselines are per machine**, so `npm run test:visual` is a local check, not a CI gate.
