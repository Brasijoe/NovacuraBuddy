# Novacura Buddy

A Chrome side-panel extension (Manifest V3) for people who build Novacura Flow apps on top of IFS Cloud.
It watches the IFS projection calls your browser makes, turns them into Flow Connect modules, and adds
tools for deploying IFS objects and moving flows between packages and environments.

📘 **User guide:** [docs/guide/Novacura-Buddy-Guide.pdf](docs/guide/Novacura-Buddy-Guide.pdf)

## Features

The side panel groups its tabs into three menus. Hover the ⓘ icons in the panel for a short explanation of each tab and section.

**IFS Functions**
- **Projection Tracker** – lists the IFS projections your IFS pages call on the selected instance. Switch one on to create its Flow module and add it to the flow open in the Designer tab. You can also search projections you haven't opened yet.
- **Traffic Recorder** – records IFS projection calls with requests and responses. Filter them in the viewer, drop redundant ones and create a Flow asset from the rest.
- **Quick Reports** – SQL Quick Reports kept in your GitHub repo. Deploy one to an IFS instance with permission sets, then create its Flow module.
- **Custom LUs** – design Custom Logical Units with attributes and deploy them to an IFS instance, or add attributes to existing LUs.
- **Flow Dependencies** – pick an IFS installation and scan it for everything that calls Novacura Flow (run.novacura.com / app.novacura.com, and/or your own addresses or parts of them): events, event actions, active workflows, routing addresses and page commands. The results open in a new tab as chains (Event → Event Action → Workflow → Routing Address → Flow endpoint), grouped per endpoint or, for run.novacura.com / app.novacura.com, per Flow package of the called automation or app (switch on the results page). Read-only.

**Flow Functions**
- **API Modules** – turns an OpenAPI 3.x or Swagger 2.0 description into a Flowscript module (list GETs become Queryables) and adds it to the open flow.
- **Import/Export** – export flows and whole packages with the modules and sub-flows they use, import such a file, or copy them straight to another organisation or package.
- **Linked Flows** – link copies of one flow across packages (all copies equal), push or pull changes with a step diff, sync a whole group and deploy the new versions to your Flow environments, with a full-tab overview of every group.

**Basic Data** – your IFS instances, credentials and the GitHub repository used for Quick Reports and Custom LUs.

## Install

1. Download `NovacuraBuddy-vX.Y.Z.zip` from the latest [GitHub Release](https://github.com/Brasijoe/NovacuraBuddy/releases/latest) and unzip it into a folder you keep (for example `C:\dev\NovacuraBuddy`). Alternatively clone this repository.
2. Open `chrome://extensions`, turn on **Developer mode** and click **Load unpacked**.
3. Select the folder that contains `manifest.json`.
4. Pin the extension and click its icon to open the side panel, then add your IFS instances under **Basic Data**.

## Updating

When a newer release exists, the side panel shows an update banner. Download the zip it links to, unzip it
over the same folder (keeping the folder keeps your saved instances and settings) and click reload on
`chrome://extensions`. If you installed from a git clone, `git pull` and reload instead.

## Releases

Bumping `version` in `manifest.json` on `master` publishes a release automatically: the
[Release workflow](.github/workflows/release.yml) runs the tests, builds `NovacuraBuddy-vX.Y.Z.zip`
(the file name the update banner looks for) and creates the `vX.Y.Z` tag and GitHub Release. If the tag
already exists it does nothing. `npm run release` does the same from a Windows PC with the `gh` CLI.

## Development

- Plain JavaScript, no build step. Load the repo folder unpacked and reload the extension after changes.
- Tests use the built-in Node test runner (Node 18+, no dependencies): `npm test`
- Layout: `background.js` (service worker), `sidepanel.*` and `panels/` (side panel UI), `lib/` (IFS, Flow and GitHub clients and logic), `recorder/` (Traffic Recorder and its viewer), `apimodule/` (OpenAPI → Flowscript), `content/` (Flow Designer content script), `scripts/` (release tooling), `docs/` (design specs, plans and the user guide).
- `firefox/` holds an older, partial Firefox (Manifest V2) port of the Projection Tracker and is not part of releases.
- New side panel tabs go into a group's `.tab-menu` in `sidepanel.html` and into `TABS` in `sidepanel.js`.

## Third-party code

MV3 extensions can't load remote scripts, so these libraries are vendored in [`lib/vendor/`](lib/vendor/VENDOR.md) under their own licenses:

| Library | Version | License |
|---|---|---|
| [Fuse.js](https://github.com/krisk/Fuse) | 7.0.0 | Apache-2.0 |
| [js-yaml](https://github.com/nodeca/js-yaml) | 4.1.0 | MIT |
| [sql-formatter](https://github.com/sql-formatter-org/sql-formatter) | 15.8.2 | MIT |

All are compatible with this project's MIT license.

## License

[MIT](LICENSE) © 2026 Johannes (Brasijoe)

Novacura Flow and IFS Cloud are products of their respective owners; this project is not affiliated with Novacura or IFS.
