# Desktop Proposals and Calendar checkpoint

8 September 2026. TELOS Delivery 4: `121ff7c4f1cbc2c8`; parent `6466711fe5c6e276`.

Proposals now presents a selectable list and full-content inspector on desktop, with stacked panels at intermediate widths. Its primary action opens the existing review session with the full proposal. Archive accurately labels the existing archive-only endpoint; Discard preserves deletion semantics. Failed reads offer retry and failed mutations restore the item with an error. Markdown is rendered without raw HTML. Existing mobile cards retain their layout and swipe actions, with corrected action labels.

Calendar presents its agenda alongside selected meeting or release detail. Day/week/release navigation, sprint information, meeting prep and video links are reused. Date/filter changes clear selection and mobile keeps inline event details. This adds no model calls for selection or navigation.

Validation: 3,575 tests across 253 files passed; server/frontend builds and lint passed. Focused tests cover selection/content isolation, full-content review, archive failure recovery, read retries and calendar actions. Synthetic browser checks cover both pages at 1440/1024/390px in light/dark themes and archive calls to the existing endpoint. No user proposals were moved or deleted. Native iOS and live backend actions were not exercised.

Delivery 4 remains active: account/settings presentation and broader live/device acceptance remain. Source authorization and authentication architecture are separate capabilities.
