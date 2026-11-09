# Keeping your own code when a module is generated again

Modules made by Novacura Buddy (API Modules tab, IFS projection modules, Module Compare "Update") are
**generated**. Without precautions, generating a module again would overwrite everything you added by
hand. Two kinds of marked block let your changes survive:

| You want to… | Use | Example |
| --- | --- | --- |
| **Add** something that is not generated (types, helper functions) | `@custom-add` | a response type, a function that reads a header |
| **Replace** a generated declaration with your own version | `@custom-replace` | a function that returns your own type instead of `text` |

The markers are plain `//` comments, so Flow ignores them and module search does not index them.
Edit the module in Flow's module editor, then generate it again whenever the API changes.

## 1. Added code

```
// @custom-add searchTypes after:getSearchResultsDialog
type DmsSearchResult = {
	repositoryName: text? = null,
}
// @custom-end
```

* `searchTypes` is a name you choose; it identifies the block.
* `after:<Name>` is optional. The block is then placed right after the generated declaration `<Name>`
  (a type or function). Without it, or if `<Name>` no longer exists, the block goes to the end of the
  module under a "Custom code" heading.
* Put one or more complete declarations between the two markers.

## 2. Replaced code

```
// @custom-replace getSearchResultsDialog
/** Search results as a typed record. */
function getSearchResultsDialog(repositoryId: text): DmsSearchResult {
    return unsafeCast<DmsSearchResult>(JSON.deserialize<{}>(GetResponse(`/r/{restPath(repositoryId)}/sr`)));
}
// @custom-end
```

* The name after `@custom-replace` must be the name of the generated declaration (`function`, `type`,
  `let` or `module`). Cut the generated declaration, paste your version between the markers.
* When the module is generated again, the generated declaration with that name is dropped and your
  block is used instead. Your own doc comment goes inside the block.
* After the first merge the marker line gets `orig:<code>`. That code identifies the generated version
  you replaced. If the API changes and the generator then produces something different for that name,
  Buddy still keeps your block but **warns** you, so you can check that it still fits.

## What happens on "Create module" / "Update"

When the module already exists, Buddy reads its current code first, then:

1. generates the new code,
2. puts every `@custom-add` block back (after its `after:` target, else at the end),
3. swaps every `@custom-replace` target for your block,
4. saves the result and tells you in one line what was kept, replaced, and any warnings.

If the current code cannot be read, nothing is saved.

## Rules and limits

* **Only marked code is kept.** Declarations you added or changed *outside* the markers are removed;
  the message lists their names ("Not generated and not inside a custom block, so removed: …").
  Wrap them in `@custom-add` before generating again.
* A block needs its `// @custom-end`. Without it, the block runs to the end of the module (and you get a
  warning).
* A replacement whose target no longer exists (for example the operation was unticked) is kept at the end
  of the module, with a warning.
* Blocks do not nest.
* Module Compare still compares your module against the freshly generated code, so a module with custom
  blocks may show as "changed" there; its Update keeps your blocks.

## Tips

* Make the change in Flow first, test it, and only then wrap it in markers.
* Copy your blocks somewhere safe before the first time you use this, in case you mistype a marker.
* The same blocks work for 3rd-party (API Modules) and IFS modules.
