# FakeMedia

Local Equicord customization. Requires the customized FakeDeafen plugin next to this directory.

Use the camera device menu, or the output audio device menu, then Fake Media. Fake Camera advertises video while leaving the real camera off. Fake Screen Share requests a Go Live session without starting a local capture source. Its own stream RTC connection is blocked, and activation is refused if that patch is unavailable.

Fake Screen Share uses the channel's regular stream permissions. It confirms receipt through STREAM_CREATE, cancels after 15 seconds without confirmation, and stops after a server deletion or leaving the channel. It does not retry automatically. Disable fake modes before using actual video or screen sharing.

Remote loading indicators are controlled by Discord. An infinite spinner is not guaranteed; a remote client may show a blank tile or an error, or Discord may terminate the stream. Build and simulated tests passed. End-to-end behavior with an observer has not been tested.
