-- Native LSP wiring (nvim 0.11+): one config file per server in <config>/lsp/,
-- binaries installed by mason (lua/plugins/lsp.lua), enabled by the scan below.

-- Rounded floats, severity-sorted, nerd-font signs
vim.diagnostic.config({
  severity_sort = true,
  float = { border = "rounded" },
  signs = {
    text = {
      [vim.diagnostic.severity.ERROR] = "",
      [vim.diagnostic.severity.WARN] = "",
      [vim.diagnostic.severity.HINT] = "",
      [vim.diagnostic.severity.INFO] = "",
    },
  },
})

-- Advertise blink.cmp completion capabilities to every server
local has_blink, blink = pcall(require, "blink.cmp")
if has_blink then
  vim.lsp.config("*", { capabilities = blink.get_lsp_capabilities() })
end

-- Buffer-local keymaps once a server attaches
vim.api.nvim_create_autocmd("LspAttach", {
  callback = function(args)
    local map = function(mode, lhs, rhs, desc)
      vim.keymap.set(mode, lhs, rhs, { buffer = args.buf, desc = desc })
    end

    map("n", "gd", vim.lsp.buf.definition, "lsp: goto definition")
    map("n", "gD", vim.lsp.buf.declaration, "lsp: goto declaration")
    map("n", "gr", vim.lsp.buf.references, "lsp: references")
    map("n", "gI", vim.lsp.buf.implementation, "lsp: goto implementation")
    map("n", "K", vim.lsp.buf.hover, "lsp: hover")
    map("n", "<leader>lr", vim.lsp.buf.rename, "lsp: rename")
    map("n", "<leader>la", vim.lsp.buf.code_action, "lsp: code action")
    map("n", "<leader>lf", function()
      vim.lsp.buf.format({ async = true })
    end, "lsp: format")
  end,
})

-- Enable every server that has a config file on the runtimepath (lsp/*.lua)
local servers = {}
for _, f in ipairs(vim.api.nvim_get_runtime_file("lsp/*.lua", true)) do
  local name = vim.fn.fnamemodify(f, ":t:r")
  -- nil_ls isn't mason-managed; only enable it where nix put `nil` on PATH
  if name ~= "nil_ls" or vim.fn.executable("nil") == 1 then
    table.insert(servers, name)
  end
end
vim.lsp.enable(servers)
