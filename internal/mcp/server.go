package mcp

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/cofys/callsign/internal/config"
	"github.com/cofys/callsign/internal/netutil"
)

const ProtocolVersion = "2025-03-26"

// Request represents a JSON-RPC 2.0 request or notification in Model Context Protocol (MCP).
type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// Response represents a JSON-RPC 2.0 response in Model Context Protocol (MCP).
type Response struct {
	JSONRPC string    `json:"jsonrpc"`
	ID      any       `json:"id"`
	Result  any       `json:"result,omitempty"`
	Error   *RPCError `json:"error,omitempty"`
}

// RPCError represents a JSON-RPC 2.0 error object.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Server implements a zero-dependency Model Context Protocol (MCP) server over
// both stdio (for Claude Desktop, Cursor, Windsurf, Cline) and Streamable HTTP (/mcp).
type Server struct {
	store          *config.Store
	lanIP          net.IP
	tailscaleIP    net.IP
	allowMutations bool
	agentToken     string
}

// NewServer creates a new MCP Server with optional write permissions and Bearer token security.
func NewServer(store *config.Store, lanIP, tailscaleIP net.IP, allowMutations bool, agentToken string) *Server {
	return &Server{
		store:          store,
		lanIP:          lanIP,
		tailscaleIP:    tailscaleIP,
		allowMutations: allowMutations,
		agentToken:     strings.TrimSpace(agentToken),
	}
}

// ServeStdio processes line-delimited JSON-RPC 2.0 MCP messages from r and writes responses to w.
func (s *Server) ServeStdio(r io.Reader, w io.Writer) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	enc := json.NewEncoder(w)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var req Request
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			_ = enc.Encode(Response{
				JSONRPC: "2.0",
				ID:      nil,
				Error:   &RPCError{Code: -32700, Message: "Parse error"},
			})
			continue
		}
		// Notifications do not have an ID and expect no response
		if req.ID == nil {
			continue
		}
		resp := s.HandleRequest(req, true)
		if err := enc.Encode(resp); err != nil {
			return err
		}
	}
	return scanner.Err()
}

// ServeHTTP implements Streamable HTTP transport for remote and Tailscale-connected AI agents.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "MCP endpoint requires HTTP POST with JSON-RPC 2.0 body", http.StatusMethodNotAllowed)
		return
	}

	var req Request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(Response{
			JSONRPC: "2.0",
			ID:      nil,
			Error:   &RPCError{Code: -32700, Message: "Invalid JSON-RPC payload"},
		})
		return
	}

	// Over HTTP (/mcp), mutation tools require BOTH --allow-agent-mutations AND a configured
	// non-empty --agent-token matching the request's Authorization: Bearer <token> header.
	// If no agent token is configured on the server, HTTP mutations are always refused.
	tokenAuthorized := false
	if s.agentToken != "" {
		auth := strings.TrimSpace(r.Header.Get("Authorization"))
		if len(auth) >= 7 && strings.EqualFold(auth[:7], "Bearer ") {
			provided := strings.TrimSpace(auth[7:])
			tokenAuthorized = provided == s.agentToken
		}
	}

	resp := s.HandleRequest(req, tokenAuthorized)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("MCP-Protocol-Version", ProtocolVersion)
	_ = json.NewEncoder(w).Encode(resp)
}

// HandleRequest dispatches a single MCP JSON-RPC request and returns a structured Response.
func (s *Server) HandleRequest(req Request, tokenAuthorized bool) Response {
	switch req.Method {
	case "initialize":
		return Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"protocolVersion": ProtocolVersion,
				"serverInfo": map[string]string{
					"name":    "callsign-mcp",
					"version": "1.0.0",
				},
				"capabilities": map[string]any{
					"tools":     map[string]any{},
					"resources": map[string]any{},
				},
			},
		}

	case "tools/list":
		return Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"tools": s.toolDefinitions(),
			},
		}

	case "tools/call":
		return s.handleToolCall(req, tokenAuthorized)

	case "resources/list":
		return Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"resources": []map[string]any{
					{
						"uri":         "callsign://topology",
						"name":        "Callsign LAN & Tailscale Topology",
						"description": "Live service directory, LAN IP, Tailscale IP, and active custom domain",
						"mimeType":    "application/json",
					},
				},
			},
		}

	default:
		return Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &RPCError{Code: -32601, Message: fmt.Sprintf("Method not found: %s", req.Method)},
		}
	}
}

func (s *Server) toolDefinitions() []map[string]any {
	return []map[string]any{
		{
			"name":        "callsign_list_services",
			"description": "Lists all active services on the local LAN and Tailscale tailnet with their .local / .x URLs, upstream targets, and TCP health.",
			"inputSchema": map[string]any{
				"type":       "object",
				"properties": map[string]any{},
			},
		},
		{
			"name":        "callsign_resolve",
			"description": "Resolves a service name (e.g. 'ollama', 'plex', 'ha') to its exact upstream host:port, LAN URL, and Tailscale URL.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name": map[string]any{
						"type":        "string",
						"description": "Service name prefix to resolve (e.g. 'ollama', 'plex', 'ha')",
					},
				},
				"required": []string{"name"},
			},
		},
		{
			"name":        "callsign_check_health",
			"description": "Performs a real-time TCP health and latency check against a registered service's upstream port.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name": map[string]any{
						"type":        "string",
						"description": "Service name to probe",
					},
				},
				"required": []string{"name"},
			},
		},
		{
			"name":        "callsign_register_service",
			"description": "Dynamically registers a local port or upstream host:port under a clean .local and .x hostname (requires agent mutation permission).",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name": map[string]any{
						"type":        "string",
						"description": "Hostname prefix (e.g. 'preview', 'api', 'ollama')",
					},
					"target": map[string]any{
						"type":        "string",
						"description": "Port number (e.g. '8000') or host:port ('127.0.0.1:5173')",
					},
				},
				"required": []string{"name", "target"},
			},
		},
		{
			"name":        "callsign_remove_service",
			"description": "Removes a registered service route by name from the active Callsign daemon and configuration (requires agent mutation permission).",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name": map[string]any{
						"type":        "string",
						"description": "Hostname prefix to remove (e.g. 'preview', 'api', 'ollama')",
					},
				},
				"required": []string{"name"},
			},
		},
	}
}

func (s *Server) handleToolCall(req Request, tokenAuthorized bool) Response {
	var callParams struct {
		Name      string            `json:"name"`
		Arguments map[string]string `json:"arguments"`
	}
	if err := json.Unmarshal(req.Params, &callParams); err != nil {
		return Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &RPCError{Code: -32602, Message: "Invalid tool call params"},
		}
	}

	domain := s.store.Domain()
	tsIPStr := ""
	if s.tailscaleIP != nil {
		tsIPStr = s.tailscaleIP.String()
	}

	switch callParams.Name {
	case "callsign_list_services":
		var items []map[string]any
		for _, svc := range s.store.List() {
			probe := netutil.ProbeTCP(svc.HostPort, 400*time.Millisecond)
			items = append(items, map[string]any{
				"name":      svc.Name,
				"target":    svc.TargetURL,
				"hostPort":  svc.HostPort,
				"localUrl":  fmt.Sprintf("http://%s.local", svc.Name),
				"domainUrl": fmt.Sprintf("http://%s.%s", svc.Name, domain),
				"online":    probe.Online,
				"latencyMs": probe.LatencyMs,
			})
		}
		out, _ := json.MarshalIndent(map[string]any{
			"domain":      domain,
			"lanIp":       s.lanIP.String(),
			"tailscaleIp": tsIPStr,
			"services":    items,
		}, "", "  ")
		return mcpTextResponse(req.ID, string(out), false)

	case "callsign_resolve":
		name := strings.ToLower(strings.TrimSpace(callParams.Arguments["name"]))
		svc, ok := s.store.Get(name)
		if !ok {
			return mcpTextResponse(req.ID, fmt.Sprintf(`{"status":"not_found","name":%q}`, name), true)
		}
		probe := netutil.ProbeTCP(svc.HostPort, 400*time.Millisecond)
		out, _ := json.MarshalIndent(map[string]any{
			"status":      "found",
			"name":        svc.Name,
			"target":      svc.TargetURL,
			"hostPort":    svc.HostPort,
			"localUrl":    fmt.Sprintf("http://%s.local", svc.Name),
			"domainUrl":   fmt.Sprintf("http://%s.%s", svc.Name, domain),
			"tailscaleIp": tsIPStr,
			"online":      probe.Online,
			"latencyMs":   probe.LatencyMs,
		}, "", "  ")
		return mcpTextResponse(req.ID, string(out), false)

	case "callsign_check_health":
		name := strings.ToLower(strings.TrimSpace(callParams.Arguments["name"]))
		svc, ok := s.store.Get(name)
		if !ok {
			return mcpTextResponse(req.ID, fmt.Sprintf(`{"error":"unknown service %q"}`, name), true)
		}
		probe := netutil.ProbeTCP(svc.HostPort, 500*time.Millisecond)
		out, _ := json.MarshalIndent(probe, "", "  ")
		return mcpTextResponse(req.ID, string(out), false)

	case "callsign_register_service":
		if !s.allowMutations {
			return mcpTextResponse(req.ID, `{"error":"Agent mutations disabled (Read-Only mode). Pass --allow-agent-mutations to enable."}`, true)
		}
		if !tokenAuthorized {
			return mcpTextResponse(req.ID, `{"error":"Unauthorized: valid Authorization: Bearer <agent_token> required for mutations."}`, true)
		}
		svc, err := config.NewService(callParams.Arguments["name"], callParams.Arguments["target"])
		if err != nil {
			return mcpTextResponse(req.ID, fmt.Sprintf(`{"error":%q}`, err.Error()), true)
		}
		s.store.Upsert(svc)
		_ = s.store.Save()
		out, _ := json.MarshalIndent(map[string]any{
			"status":    "registered",
			"name":      svc.Name,
			"target":    svc.TargetURL,
			"localUrl":  fmt.Sprintf("http://%s.local", svc.Name),
			"domainUrl": fmt.Sprintf("http://%s.%s", svc.Name, domain),
		}, "", "  ")
		return mcpTextResponse(req.ID, string(out), false)

	case "callsign_remove_service":
		if !s.allowMutations {
			return mcpTextResponse(req.ID, `{"error":"Agent mutations disabled (Read-Only mode). Pass --allow-agent-mutations to enable."}`, true)
		}
		if !tokenAuthorized {
			return mcpTextResponse(req.ID, `{"error":"Unauthorized: valid Authorization: Bearer <agent_token> required for mutations."}`, true)
		}
		name := strings.ToLower(strings.TrimSpace(callParams.Arguments["name"]))
		if name == "" {
			return mcpTextResponse(req.ID, `{"error":"service name is required"}`, true)
		}
		if !s.store.Remove(name) {
			return mcpTextResponse(req.ID, fmt.Sprintf(`{"error":"unknown service %q"}`, name), true)
		}
		_ = s.store.Save()
		out, _ := json.MarshalIndent(map[string]any{
			"status": "removed",
			"name":   name,
		}, "", "  ")
		return mcpTextResponse(req.ID, string(out), false)

	default:
		return Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &RPCError{Code: -32602, Message: fmt.Sprintf("Unknown tool: %s", callParams.Name)},
		}
	}
}

func mcpTextResponse(id any, text string, isError bool) Response {
	return Response{
		JSONRPC: "2.0",
		ID:      id,
		Result: map[string]any{
			"isError": isError,
			"content": []map[string]string{
				{
					"type": "text",
					"text": text,
				},
			},
		},
	}
}
