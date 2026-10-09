package lane

import "time"

// SetBridgeLossGrace shortens the post-loss grace for the black-box tests (the package's
// TestMain sets it once; the production value is 30 s).
func SetBridgeLossGrace(d time.Duration) { bridgeLossGrace = d }
