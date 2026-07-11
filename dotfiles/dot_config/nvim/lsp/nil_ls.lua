-- not mason-managed: nix hosts provide `nil` themselves (see config/lsp.lua guard)
return {
  cmd = { "nil" },
  filetypes = { "nix" },
  root_markers = { "flake.nix", ".git" },
}
