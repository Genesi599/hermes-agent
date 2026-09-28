import { afterEach, describe, expect, it } from 'vitest'

import { deliveredToFocusedRoom } from './session-states'
import { $roomByRoutingSessionId, rememberRoomRouting } from './room-routing'

// 2026-09-28: a dispatched turn runs in the routing conversation
// (`Book · Hermes`) while the user watches the ROOM (`Book`). The finish must
// not earn that conversation a completed-unread dot when the room it speaks
// into is the one on screen.
afterEach(() => {
  $roomByRoutingSessionId.set({})
})

describe('deliveredToFocusedRoom', () => {
  it('exempts a routing conversation whose room is focused', () => {
    rememberRoomRouting('20260918_103217_18e06d', '20260912_104722_221d2b')

    expect(deliveredToFocusedRoom('20260918_103217_18e06d', '20260912_104722_221d2b')).toBe(true)
  })

  it('does not exempt when another conversation is focused', () => {
    rememberRoomRouting('20260918_103217_18e06d', '20260912_104722_221d2b')

    expect(deliveredToFocusedRoom('20260918_103217_18e06d', '20260924_100245_d0e7f2')).toBe(false)
  })

  it('does not exempt without focus', () => {
    rememberRoomRouting('20260918_103217_18e06d', '20260912_104722_221d2b')

    expect(deliveredToFocusedRoom('20260918_103217_18e06d', null)).toBe(false)
  })

  it('does not exempt an unmapped conversation', () => {
    expect(deliveredToFocusedRoom('20260918_101638_6889e4', '20260912_104722_221d2b')).toBe(false)
  })
})
