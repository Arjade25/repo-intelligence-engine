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

<sub>Runtime imports only: type-only imports and dynamic <code>import()</code> don't count, and barrel re-exports do. Cycles already on the base branch never fail a PR.</sub>
