# Meeting chat upgrade (v4.25)

Scope: the chat tab of the Qorlla Meet page only. Source of the design: `Qorla-chat-page-ext/qorlla-chat-upgrade` (a React + SQLite prototype). Status: **implemented and tested in a local, isolated stack; not production-certified.**

## What the meeting chat can now do

| Feature | Notes |
|---|---|
| Reply, quote | a reply stores a link to the original (same meeting only); a quote is a reply that also carries the quoted words |
| Edit | author only, text messages only; everyone sees "edited" |
| Rich text | bold, italic, underline, strikethrough, bullet list, heading, https links; pasted text is always plain |
| Copy | plain text to the clipboard |
| Bookmark | private to the person |
| Pin for everyone | host only; shown to all; "pinned" filter |
| Create task | from any message: title, optional due date, optional assignee (must be an admitted participant); shown under the message to everyone |
| Search | by words or author, plus pinned and bookmarked filters (client-side over the loaded history; the API also supports `?q=`, `?pinned=1`, `?bookmarked=1`, `?before=`) |
| GIFs | **off** unless `GIPHY_API_KEY` is set (see below) |
| File attachments | **off** unless `CHAT_ATTACHMENTS_ENABLED=true` (see below) |

## How it differs from the prototype (and why)

The package could not be dropped in as is: it is a separate React/SQLite app, and its server identifies people by a client-supplied `x-demo-user` header, which its own README says must never be exposed. So the features were re-implemented in Meet's own stack and the unsafe parts were NOT carried over:

* **Identity and permissions** come only from Meet's verified token and the admitted-participant check. No header or field from the page is trusted. Pinning is host-only (the prototype let anyone pin).
* **Scope** is the meeting. The prototype's "All-on-Board" workspace room and "New Chat to user IDs" belong to the workspace chat and were left out.
* **Rich text is not stored or shown as HTML.** The prototype used `execCommand` plus client-side DOMPurify. Here the server turns what the page sends into a canonical string that can contain only `b i u s br ul li h2 blockquote` and `a href="https://..."`, and the page builds DOM nodes from it (no `innerHTML`). The same module (`public/chat-markup.js`) runs on both sides.
* **`messages.body` stays plain text**, so the AI summary, the integration export and older pages read it unchanged; `body_rich` holds the canonical markup.
* **Live delivery** uses the existing Socket.IO room events instead of 4-second polling.
* **GIF search is proxied** through the server so the GIPHY key never reaches the page. The words people search for still go to GIPHY: enable it only if that is acceptable.
* **Attachments**: no multer dependency; raw upload, type decided by the file's bytes (PNG, JPEG, WebP, PDF, plain text), 10 MB limit, downloads only for admitted participants of the same meeting, always served as a download with a fixed type and `nosniff`.

## Switching optional features on

* `GIPHY_API_KEY=<key>` enables GIF search and widens the page's image policy to GIPHY hosts only.
* `CHAT_ATTACHMENTS_ENABLED=true` (and optionally `CHAT_ATTACHMENTS_DIR`) enables attachments. **No malware scanner is built in.** Do not enable it for real users until files are scanned and stored in private object storage with quotas and retention.

## Tests

* `tests/chat-markup.test.mjs`: 9 tests on the sanitizer (script, handlers, images, frames, `javascript:`/`data:` links, entity and nesting tricks, control and bidi characters, limits, idempotence).
* `tests/chat.test.mjs`: 19 tests against a real PostgreSQL (the first 10 are the v4.25 set): permissions, cross-meeting isolation, validation, edit/pin/bookmark/task rules, search escaping, GIF and attachment limits.
* `tests/e2e/chat-browser.e2e.mjs`: 111 checks (V2.1 included) (the v4.25 25 plus the v4.26 set below) in real browsers (Stryker host, Justin guest) plus an emulated phone: live delivery, bold, reply, quote, edit, private bookmark, host-only pin, task, search, typed HTML shown as text and not executed, phone layout, no JavaScript errors.
* The existing Meet suite still passes together with the new tests (see the V2.0 section for the final counts).

## Not covered

* No real-device or Safari testing; GIF and attachment paths were tested with a stub, not live GIPHY or a scanner.
* Search is over the loaded history (the last 100 messages) in the page; there is no "load older" control yet.
* The Workplace AI chat export still receives plain text only (by design); consent handling is unchanged.
* Not production-certified: no load test, no independent security review.

## Qorlla Meet Chat V2.0 (v4.26): conversations, host policy, delete, Save chat, pop-out

Second source package: `Qorla-chat-page-ext/qorlla-meet-chat-integ-save-popup` (header menu with "Save chat" and "Participant can chat with", pop-out, Everyone + New chat, delete, idempotent sends). Like the first package it assumed Portal sessions (cookie introspection), Redis and its own server, so it was not dropped in: its features were implemented on **Meet's own tokens, participants table, PostgreSQL and Socket.IO**. Nothing in the Portal or the Portal chat branch was touched.

| Feature | How it works here |
|---|---|
| **Everyone** | the meeting-wide chat, exactly as before (`messages.conversation_id IS NULL`) |
| **New chat** | a private conversation with 1 to 20 admitted participants; the same set of people is always ONE conversation; only its members can read it, receive its live events, export it, act on its messages, or download its attachments (anybody else gets 404, as if it did not exist) |
| **Host policy** ("Participants can chat with") | `meetings.chat_policy`, host only to change, enforced on every send and on creating a chat: **none** (participants cannot chat), **hosts** (participants may chat privately with the host only), **group** (Everyone only; **the default, which is how chat behaved before**), **all** (Everyone and private chats with anyone). The host is never restricted. Meet has no co-host role, so "host and co-hosts" means the host. Changes are pushed live to every page |
| **Delete** | the author, or the host; the text is removed from the database (not hidden); everybody who could see it sees "Message deleted"; a second click confirms in the UI |
| **Save chat** | downloads the conversation on screen as a text file; contains only what that person may see, without deleted messages |
| **Pop-out** | the live chat panel moves into its own window (same page, same sign-in, same call connection, nothing is rejoined, so it can never be a stale copy); closing the window or "Bring chat back" returns it |
| **Idempotent sends** | each send carries a key; a retry returns the same message and announces nothing twice |
| **Close** | closes the Meet side panel (or brings the chat back from a pop-out) |

### V2.0 look (in place, inside the existing five-tab panel)

Title "Qorlla Meet Chat" with the meeting title as the subtitle; More, Pop-out and Close; conversation chips (Everyone, New chat); empty state "Meeting messages appear here"; formatting row B, I, U, link, attach, GIF; rounded composer with an icon Send button. Attach and GIF are **always visible**; when the server has not enabled them they are **disabled with a tooltip saying why** (no GIPHY key / no malware scanning). Strikethrough, bullet list and heading are still accepted by the server and rendered, but are no longer in the toolbar (the design shows B, I, U, link only).

### Privacy invariants (all tested)

* A private message never appears in `/api/integrations/meetings/:id/chat` (the AI summary and Workplace export), in `GET /meetings/:id`, in Everyone, in search, in pins, in tasks, or in the live events of anybody who is not a member (events go to the members' own sockets, not the meeting room).
* A reply must be in the same conversation as its target. Pins are for Everyone only. A task's assignee must be able to see the conversation. An attachment is reachable only through a message the person can read (an unposted upload only by its uploader).
* The host does not see private chats they are not part of, and cannot delete or pin inside them.

### Tests added

* `tests/chat.test.mjs`: 19 tests (7 new in V2.0, 2 in V2.1): policy matrix, private visibility (reads, events, tasks, search, export), delete, Save chat, idempotency, attachments in private chats, and a denied participant (no events, every route refused).
* `tests/e2e/chat-browser.e2e.mjs`: 111 checks (V2.1 included) in real browsers (Stryker host, Justin guest, Pia on an emulated phone): V2.0 header/composer/empty state; the policy (none, host only, group, all) changing live for guests; a private chat a third person never sees; the integration export staying clean; delete with confirmation; Save chat; pop-out synchronisation (send, edit, pin, delete in both directions, close and reopen); a dropped network resyncing without loss or duplicates; a removed participant receiving nothing in the main or the pop-out window and being refused by every route.
* `tests/e2e/meet-tabs.e2e.mjs`: 17 checks over **all five tabs** (Chat, People, Notes, Polls, More) with a host and a guest: one tab visible at a time, People roles, Notes and More content, Polls host-only, nothing lost when returning to Chat, messages that arrive while another tab is open, Close and reopen.
* The existing ASCS browser regression (A to F) and the whole Meet server suite still pass.

### Delivery, reconnection, removal and the pop-out: how they are secured

* **Per-socket delivery.** Chat events are no longer a room broadcast. For every event the server asks who is *admitted right now* (and, for a private chat, who is a member) and sends to those people's own sockets. A person whose admission was withdrawn (the Shield session guard or the host writes `admission='denied'` and closes the socket) stops receiving chat even if their socket was not closed yet; their token is refused by every chat route (read, post, export, conversations, policy, tasks).
* **Reconnection.** After a socket reconnect the page reloads the conversation from the server (a measured resync takes about half a second), so messages sent while it was offline appear exactly once and none are duplicated. The browser test drops a guest's network, sends two messages, restores it and compares what the page shows with what is stored.
* **Sending.** The composer clears the moment you send (the typed text is captured first), so whatever you type while the server answers is the next message and is never lost; if a send fails the text comes back.
* **Pop-out is not a second client.** The pop-out is a window the page itself opens (`window.open('')`, same origin) into which the page moves the existing chat panel. There is no URL to put a token in, no second page load, no second login, and **no second socket** (Meet keeps one socket per participant, and a second one would replace the first and break the call). No `postMessage` channel exists, so there is no origin/source handshake to get wrong; the pop-out can only be driven by the page that opened it. If pop-ups are blocked the user is told.

### What `Qorlla Meet Chat V2.0` does NOT claim

* Not production-certified: no load test, no independent security review, no real-device or Safari test, no live GIPHY or malware scanner (attachments and GIFs are disabled by default and were tested with stubs).
* Search covers the loaded history (the last 100 messages) of the conversation on screen; there is no "load older" control yet.
* Retention, moderation and legal hold are not part of this change.
* Co-hosts do not exist in Meet, so "host and co-hosts" means the host.
* Production verdict: **NO-GO** until certification.

## V2.1: message actions, full format toolbar, popovers, composer card (Qorlla look; no third-party branding)

Reference screenshots (a meeting chat with hover actions, a format toolbar, a GIF picker and a file menu) were used for **layout ideas only**: the wording, colours and icons are Qorlla's own.

| Area | What it does |
|---|---|
| **Message actions** | Reply and More (the three dots) appear beside the bubble on hover or keyboard focus, as small ghost icon buttons; on touch screens they stay below the bubble. More menu: Copy, Quote, Edit (own text only) / Bookmark / Pin for everyone (host, Everyone only) / Create task / Delete (author or host, second click confirms) |
| **Format toolbar** (the **T** button shows it) | Bold, Italic, Underline, Strikethrough, text colour, text size, link, heading, and a "..." menu (bulleted list, numbered list, quote, clear formatting). Enter makes the next item inside a list and leaves the list on an empty item; Ctrl+Enter always sends |
| **Colour and size are NOT styles** | A fixed palette of six colours (tags `c1` to `c6`) and three sizes (`z1` small, `z2` large, `z3` huge). The server sanitizer is an allowlist: no attribute is ever kept (so no `style`, `class`, `onclick`, `data-*`), `<span>`/`<font>`/unknown or out-of-range tags (`c0`, `c7`, `z4`) are dropped keeping their text, and the page draws the colours from its own style sheet. The same module renders, converts to plain text (exports and the AI summary keep bullets and numbers) and reads the editor |
| **Who can see your messages?** | A bar above the composer opens a popover whose text comes from the server: "Everyone in this meeting (N people)" or "Only you and <names>", and that the host cannot read private chats they are not part of and that private chats are never in summaries or exports |
| **GIF picker** | Needs `GIPHY_API_KEY`. A "Search GIPHY" box, a two-column masonry of previews, "Powered by GIPHY" and a note that the search words go to GIPHY through this meeting's server. The server proxies the search (the key never reaches the page) and the policy allows GIPHY images **only when the key is set**. Without a key the button stays visible, disabled, with a tooltip |
| **File menu** | "Your computer" works only when the server has `CHAT_ATTACHMENTS_ENABLED=true`. Dropbox, Microsoft OneDrive, Google Drive, Box and Microsoft SharePoint are listed **disabled** with the tooltip "Not connected: needs provider setup by an administrator". There is **no OAuth or connector code in this repository**, the server exposes no such routes (tested), and nothing pretends otherwise. Security of attachments is unchanged: type decided by the file's bytes, 10 MB limit, authorized download only through a message the person can read. **No malware scanner exists**: keep the flag off until files are scanned and stored in private object storage |
| **Pinned messages panel** | The pin button lists the pinned messages with "Go to message" |
| **Composer** | One distinct card: context bar / toolbar (when T is on) / input and Send / T, GIF, File. The hint "Message everyone..." is driven by state (not CSS `:empty`, which never matches a contentEditable after text was deleted). Editing shows "Editing: <the original text>"; Esc or the X cancels; emptying an edit asks "Delete it instead?" instead of silently doing nothing |
| **Link** | A small popover next to the link button (Enter adds, Esc closes, closes after use); the selected text becomes the link |

**Not built, on purpose:** QorllaMate / AI in the Meet chat. Meet has no AI client; AI runs only through the Portal AI gateway with consent, and **no chat content is sent to any AI or third-party service from this panel** (the only external call is the optional GIPHY search, described above).

Tests added for V2.1: sanitizer 12 (palette, injection through the new tags, `Object.prototype` tag names, numbered lists); API 19 (audience, no cloud routes, GIPHY base); chat browser 111; optional-features browser 14 (GIF picker and files, with a local stand-in for GIPHY).

A bug found while writing these tests, in the already-pushed V2.0: the sanitizer looked tags up in a plain object, so a tag named like an `Object.prototype` property (for example `<constructor>`) produced broken markup. It was escaped text (not an XSS), and it is fixed and covered by a test.
