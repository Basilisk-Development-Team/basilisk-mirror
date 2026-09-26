# Phase 5 implementation baseline

Repository boundary recorded before edits:

* Basilisk HEAD: 35845b3.
* Recorded platform gitlink: f865b384ebe9a86d17e0f015482d8b5d7bb283bc.
* Actual platform checkout: 845e0e1a2ffd48d33a48ca89fa72acc61399395b.
* `git -C platform status --short`: empty. Basilisk reports the pre-existing
  ` M platform` revision difference. Neither revision nor any platform file is
  to be changed by this work.

Implementation order:

1. Add an optional generic capability for persistent, independently isolated
   document/frame execution worlds, including script-global evaluation. Keep
   native implementation wholly in Basilisk's backend adapter.
2. Add Basilisk-owned target handles, ordered queues, versioned JSON configuration,
   restricted named messages and script/CSS lifecycle handling. No Cu/Services
   replacement, fake window prototype or arbitrary privileged script injection.
3. Exercise independent extension contexts, ordering, globals, data snapshots and
   stale targets against real alternate content and a generic test driver where
   practical. Run existing fixtures and clean-XPI audit separately.
4. Document public-API request-broker feasibility and a separate upstream proposal.
   Do not implement live network policy through compiled rules or guessed metadata.
5. Recheck disabled gating and the exact platform baseline; report any unsupported
   bootstrap/service-interposition contracts explicitly.
