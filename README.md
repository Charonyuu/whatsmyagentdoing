# Scene pack sources

Source folders for the downloadable 3D scenes of [whatsmyagentdoing](https://github.com/Charonyuu/whatsmyagentdoing).
Each folder is a `manifest.json` plus meshopt-compressed Kenney CC0 models.

Build a pack from the main branch checkout:

```bash
node scripts/pack-scene.js packs/<id>
```

then upload `dist/<id>-v<version>.tar.gz` to the `scenes` release and commit the updated `scenes.json` on main.

Newer packs (`christmas`, `arcade`) are generated: edit the layout in
`<id>/build.js` and run `node <id>/build.js` to rewrite its `manifest.json`
(add `--prune` before packing to drop unused kit models). `lib/plan.js` draws
a manifest top-down as a PNG for a quick layout check without a browser.
