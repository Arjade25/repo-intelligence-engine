<!-- rie-check -->
### rie check: fail

Compared with `4462d6914c`. Runtime import cycle groups: 15 on base, 15 with this PR.

| Outcome | Event | Change |
|---|---|---|
| fail | `cycle_grown` | cycle of 126 files grew to 136 |

#### fail: `cycle_grown`, cycle of 126 files grew to 136

Joined: `src/stores/room-list-v3/RoomListStoreV3.ts`, `src/stores/room-list-v3/section.ts`, `src/stores/room-list-v3/skip-list/RoomNode.ts`, `src/stores/room-list-v3/skip-list/RoomSkipList.ts`, `src/stores/room-list-v3/skip-list/filters/MentionsFilter.ts`, `src/stores/room-list-v3/skip-list/filters/UnreadFilter.ts`, `src/stores/room-list-v3/skip-list/sorters/BaseRecencySorter.ts`, `src/stores/room-list-v3/skip-list/sorters/RecencySorter.ts`, `src/stores/room-list-v3/skip-list/sorters/UnreadSorter.ts`, `src/stores/room-list-v3/skip-list/sorters/utils/getLastTimestamp.ts`

Loop of 6 files through an import this PR adds:

```
src/components/views/dialogs/InviteDialog.tsx:29  import RoomListStoreV3 from "../../../stores/room-list-v3/RoomListStoreV3";  (runtime: default)
src/stores/room-list-v3/RoomListStoreV3.ts:22     import SpaceStore from "../spaces/SpaceStore";  (runtime: default)
src/stores/spaces/SpaceStore.ts:38                import { TAG_ORDER } from "../../components/views/rooms/LegacyRoomList";  (runtime: TAG_ORDER)
src/components/views/rooms/LegacyRoomList.tsx:52  import { shouldShowSpaceInvite, showAddExistingRooms, showCreateNewRoom, showSpaceInvite, } from "../../../utils/space.tsx";  (runtime: shouldShowSpaceInvite, showAddExistingRooms, showCreateNewRoom, showSpaceInvite)
src/utils/space.tsx:20                            import { showRoomInviteDialog } from "../RoomInvite";  (runtime: showRoomInviteDialog)
src/RoomInvite.tsx:16                             import InviteDialog from "./components/views/dialogs/InviteDialog";  (runtime: default)
```

##### Explanation (verified facts)

The PR replaced InviteDialog.tsx's import of the legacy RoomListStore with `import RoomListStoreV3 from "../../../stores/room-list-v3/RoomListStoreV3"` (line 29). InviteDialog was already in the large runtime cycle. RoomListStoreV3 imports SpaceStore, and SpaceStore leads back to InviteDialog through LegacyRoomList → utils/space → RoomInvite. So RoomListStoreV3 is now in the cycle too, and so are 9 other room-list-v3 files that are tied to it: section.ts and the skip-list files (RoomSkipList, RoomNode, MentionsFilter/UnreadFilter, the recency/unread sorters and getLastTimestamp). The cycle grows from its base size by these 10 files. The import is a runtime import: InviteDialog calls `RoomListStoreV3.instance.getDmRooms()`. Load order now depends on which of these files is imported first. A module in the loop can run before RoomListStoreV3 or its sorters have finished loading, and then a top-level reference to one of them can be `undefined` or throw a TDZ error. The LoggedInView.tsx change in the same PR was not reported as part of this loop.

##### Suggestions (not verified)

- In InviteDialog.buildRecents, load the store lazily instead of importing it at the top of the file. For example, use a dynamic `await import("../../../stores/room-list-v3/RoomListStoreV3")`, or pass the DM rooms into buildRecents as an argument from a caller outside the cycle. Either way, InviteDialog.tsx stops importing RoomListStoreV3 at load time.
- Compute the DM-tagged rooms without RoomListStoreV3. You could call `getTagsForRoom` (src/utils/room/getTagsForRoom) directly on the client's visible rooms in InviteDialog, or move that logic into a small helper that doesn't import SpaceStore. The tag check is what the new getDmRooms() does, but getDmRooms() also limits results to the active space, so this would change which rooms are returned.
- Break the existing back-edge instead: SpaceStore.ts imports TAG_ORDER from components/views/rooms/LegacyRoomList.tsx. Moving TAG_ORDER into a constants module with no UI imports would cut the SpaceStore → LegacyRoomList → utils/space → RoomInvite → InviteDialog path. This would also shrink the existing cycle.
- Revert InviteDialog.tsx to the legacy `RoomListStore.instance.orderedLists[DefaultTagID.DM]` lookup, which was already in the cycle, until the migration can be done without this import.

<sub>Runtime imports only: type-only imports and dynamic <code>import()</code> don't count, and barrel re-exports do. Cycles already on the base branch never fail a PR.</sub>
