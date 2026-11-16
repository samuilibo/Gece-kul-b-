# music/

Put **only music you are licensed to stream publicly and use commercially** here
(your own productions, tracks bought with a streaming/commercial licence, CC0 / CC-BY tracks
whose attribution you show on stream, etc.). Do not rip from Spotify, YouTube or other services.

Supported: `.mp3`, `.wav`, `.ogg`, `.m4a`, `.aac`, `.flac`, `.opus`, `.webm`.

Optional genre sub-folders make `!song <genre>` votes and events pick matching tracks:

```
music/
  edm/  techno/  deephouse/  progressive/  trance/  hiphop/  disco/  synthwave/  turkish/
```

Files directly in `music/` play in the general rotation. When a genre has no files, the built-in
original generative synth (part of this project, see ASSET_LICENSES.md) plays that genre instead.
Use the admin panel → Music → "Rescan folder" after adding files.
