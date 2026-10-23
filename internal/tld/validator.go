package tld

import (
	"fmt"
	"strings"
)

// Tier represents the safety classification of a custom LAN domain suffix.
type Tier string

const (
	TierGreen  Tier = "GREEN"
	TierYellow Tier = "YELLOW"
	TierRed    Tier = "RED"
)

// ValidationResult holds the classification and human-readable explanation for a domain suffix.
type ValidationResult struct {
	Domain  string `json:"domain"`
	Tier    Tier   `json:"tier"`
	Title   string `json:"title"`
	Message string `json:"message"`
	Blocked bool   `json:"blocked"`
}

// Red Tier: Browser HSTS-preloaded gTLDs and reserved special-use names that break plain HTTP or mDNS.
var redTLDs = map[string]string{
	"dev":       "Google Registry HSTS-preloaded TLD; Chrome/Edge/Firefox/Safari force HTTPS and block plain HTTP on *.dev",
	"app":       "HSTS-preloaded TLD; all modern browsers hard-block plain HTTP on *.app",
	"page":      "HSTS-preloaded TLD; browsers force HTTPS and reject plain HTTP on *.page",
	"new":       "HSTS-preloaded TLD; browsers force HTTPS on *.new",
	"foo":       "HSTS-preloaded TLD; browsers force HTTPS on *.foo",
	"day":       "HSTS-preloaded TLD; browsers force HTTPS on *.day",
	"channel":   "HSTS-preloaded TLD; browsers force HTTPS on *.channel",
	"local":     "Reserved by RFC 6762 for Multicast DNS (mDNS); lanname already announces *.local automatically via UDP 5353",
	"localhost": "Reserved by RFC 6761 as loopback; browsers resolve *.localhost to 127.0.0.1 internally and ignore LAN DNS",
}

// Yellow Tier: Delegated public ICANN gTLDs/ccTLDs that risk query leakage or collision when off-network.
var yellowTLDs = map[string]bool{
	"com":   true,
	"net":   true,
	"org":   true,
	"io":    true,
	"xyz":   true,
	"ai":    true,
	"tech":  true,
	"cloud": true,
	"co":    true,
	"me":    true,
	"tv":    true,
	"sh":    true,
	"gg":    true,
	"cc":    true,
	"info":  true,
	"biz":   true,
}

// Validate classifies a domain suffix into Green, Yellow, or Red safety tiers.
// If force is true, a Red tier domain is downgraded from Blocked=true so advanced users can override it.
func Validate(domain string, force bool) ValidationResult {
	clean := strings.ToLower(strings.Trim(strings.TrimSpace(domain), "."))
	if clean == "" {
		clean = "lan"
	}

	// Check final label if user passed a multi-label suffix like "home.arpa" or "my.dev"
	parts := strings.Split(clean, ".")
	lastLabel := parts[len(parts)-1]

	if reason, isRed := redTLDs[clean]; isRed {
		return ValidationResult{
			Domain: clean,
			Tier:   TierRed,
			Title:  fmt.Sprintf("Unsafe Domain Suffix (.%s)", clean),
			Message: fmt.Sprintf(
				"%s. Choose a safe private suffix like --domain cofy, --domain lan, or --domain home (or pass --force to override).",
				reason,
			),
			Blocked: !force,
		}
	}

	if reason, isRed := redTLDs[lastLabel]; isRed {
		return ValidationResult{
			Domain: clean,
			Tier:   TierRed,
			Title:  fmt.Sprintf("Unsafe Parent TLD (.%s)", lastLabel),
			Message: fmt.Sprintf(
				"%s. Choose a safe private suffix like --domain cofy, --domain lan, or --domain home (or pass --force to override).",
				reason,
			),
			Blocked: !force,
		}
	}

	if yellowTLDs[clean] || yellowTLDs[lastLabel] {
		return ValidationResult{
			Domain: clean,
			Tier:   TierYellow,
			Title:  fmt.Sprintf("Public ICANN TLD Warning (.%s)", clean),
			Message: fmt.Sprintf(
				".%s is a delegated public internet TLD. Shadowing it on your LAN can mask real internet domains and leak internal hostnames when laptops roam off-Wi-Fi. Consider an unallocated suffix like --domain cofy or --domain home.arpa.",
				clean,
			),
			Blocked: false,
		}
	}

	return ValidationResult{
		Domain:  clean,
		Tier:    TierGreen,
		Title:   fmt.Sprintf("Safe Private Suffix (.%s)", clean),
		Message: fmt.Sprintf(".%s is safe for local LAN resolution (no HSTS preload conflicts or public ICANN collisions).", clean),
		Blocked: false,
	}
}
