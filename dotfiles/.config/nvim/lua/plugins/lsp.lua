-- mason only installs server binaries; server configs live in <config>/lsp/
-- and are enabled natively by lua/config/lsp.lua (nvim 0.11+ vim.lsp.enable)
return {
  "mason-org/mason.nvim",
  lazy = false, -- must set up early so its bin dir is on PATH before servers start
  opts = {},
  config = function(_, opts)
    require("mason").setup(opts)

    local ensure_installed = {
      "lua-language-server",
      "gopls",
      "terraform-ls",
      "yaml-language-server",
      "bash-language-server",
      "json-lsp",
    }

    local registry = require("mason-registry")
    registry.refresh(function()
      for _, name in ipairs(ensure_installed) do
        local pkg = registry.get_package(name)
        if not pkg:is_installed() then
          pkg:install()
        end
      end
    end)
  end,
}
