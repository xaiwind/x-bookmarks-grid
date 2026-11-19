# Chrome Web Store listing — English

Use this text for the English (default) listing. The Chinese listing is in `listing.md`.
The package to upload is the same zip for every language: `npm run package`.

## Store listing

**Name** (comes from `_locales/en/messages.json`)

    X Bookmarks Grid

**Short description** (comes from `_locales/en/messages.json`, max 132 characters)

    Unofficial tool: sync your X bookmarks into a local library and browse them in a grid, filtered by author, type and date.

**Detailed description**

    Turn your X (Twitter) bookmarks into a local library you can search, filter and organise.

    ● Read everything in one go: syncing starts when you open the extension; afterwards only new bookmarks are read.
    ● Grid view: every bookmark shows its cover, title, author, date and view count.
    ● Filters that don't overlap: Articles / Video / Images / Text / Untitled — the counts add up to the total. Combine any of them with "1M+ views".
    ● Search titles, authors, links and your own notes; @name finds an author.
    ● Right-click a card to open the post, sync just that post, edit its title and note, download it as Markdown, or delete it from the library (with undo).
    ● Download into your own folder, such as an Obsidian vault, with photos and videos saved alongside. Downloaded posts are marked, and downloading again lets you replace or keep both.
    ● Backup: export and import your whole library as one file.
    ● Interface in English and Chinese: follows your browser language, and you can switch with one click.

    Privacy
    ● All data stays in your own browser. Nothing is uploaded to any server. No analytics, no ads.
    ● The extension uses the X session you are already signed in to, to read your own bookmarks. It does not store cookies or passwords.
    ● Only titles, cover links and similar details are stored — never post text. When you download a post as Markdown, its text goes only into the file you download.

    Good to know
    ● This is a third-party tool. It is not affiliated with or endorsed by X Corp.
    ● You need to be signed in to X in your browser. While syncing, the extension briefly opens the X bookmarks page in a background tab and closes it when done.
    ● Changes on X's side can temporarily break syncing.

**Category**: Tools

## Privacy practices tab

**Single purpose**

    Sync the user's own X bookmarks and provide a local grid view to browse, search, filter and organise them.

**Permission justifications**

| Permission | Justification |
| --- | --- |
| `storage` | Stores sync settings, sync progress and the time of the last sync. |
| `unlimitedStorage` | The bookmark library is kept in local IndexedDB. Users with many bookmarks can exceed the default quota, and the permission prevents the browser from evicting the user's library when disk space is low. |
| `alarms` | Runs the optional once-a-day sync of new bookmarks at a time the user chooses. |
| `scripting` | Runs the reader script in X pages that the extension itself opened: to read the bookmark list and, when the user asks, the title or text of a single post. When the user downloads a post, the extension registers a script on X post pages only for the duration of that read. The script picks the photo and video addresses and the view count out of the post data X's own page loads, and is unregistered as soon as the read finishes. It does not change the page or send any data. |
| Host permissions `x.com`, `twitter.com` | Bookmarks only exist on X. The extension reads the user's own bookmarks on X's bookmark and post pages. |
| Host permissions `pbs.twimg.com`, `video.twimg.com` | These are X's image and video servers. When the user downloads a bookmark, the extension saves that post's photos and videos into a folder the user chose, so they can be viewed offline. They are accessed only when the user clicks Download. No other site is accessed. |

**Remote code**: No. All code is in the package.

**Data usage**

- The extension reads content on X pages (website content) and notes the user writes. All of it stays on the user's device and is never transmitted to the developer or any third party.
- The store defines collection as data leaving the user's device, so no data type needs to be ticked. If a reviewer disagrees, tick "Website content" and state that it is processed locally only.
- Tick all three certifications: no selling of data, no use for unrelated purposes, no use for creditworthiness.

**Privacy policy URL**: required. Publish `privacy-policy-en.md` (and optionally the Chinese `privacy-policy.md`) at a public URL and paste it here. Replace the contact email first.
