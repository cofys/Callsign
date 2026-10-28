package tld

import (
	"testing"
)

func TestValidateCustomExtensions(t *testing.T) {
	// Any extension is acceptable as long as it's NOT a real extension!
	// Single letter extensions (.a, .b, .c, .x, .z) must be TierGreen.
	greenCases := []string{
		"a", "b", "c", "d", "e", "x", "z",
		"hub", "home", "lan", "lab", "box", "homelab", "hq", "mybox",
		"internal", "private", "netlab",
	}

	for _, ext := range greenCases {
		res := Validate(ext, false)
		if res.Tier != TierGreen {
			t.Errorf("expected extension .%s to be TierGreen, got %s (blocked=%v)", ext, res.Tier, res.Blocked)
		}
		if res.Blocked {
			t.Errorf("expected extension .%s to not be blocked", ext)
		}
	}
}

func TestValidateRealExtensionsBlockedOrWarned(t *testing.T) {
	// Real HSTS extensions must be TierRed and blocked by default
	redCases := []string{"dev", "app", "page", "new", "foo", "local", "localhost"}
	for _, ext := range redCases {
		res := Validate(ext, false)
		if res.Tier != TierRed {
			t.Errorf("expected real extension .%s to be TierRed, got %s", ext, res.Tier)
		}
		if !res.Blocked {
			t.Errorf("expected real extension .%s to be blocked without --force", ext)
		}

		// With force, it should not be blocked
		forced := Validate(ext, true)
		if forced.Blocked {
			t.Errorf("expected real extension .%s with force to not be blocked", ext)
		}
	}

	// Real ICANN public extensions must be TierYellow
	yellowCases := []string{"com", "net", "org", "io", "xyz", "ai", "tech", "cloud", "online", "site"}
	for _, ext := range yellowCases {
		res := Validate(ext, false)
		if res.Tier != TierYellow {
			t.Errorf("expected real public extension .%s to be TierYellow, got %s", ext, res.Tier)
		}
		if res.Blocked {
			t.Errorf("expected real extension .%s to produce warning, not hard block", ext)
		}
	}
}
