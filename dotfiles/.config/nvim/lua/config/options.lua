local opt = vim.opt

-- Indentation
opt.tabstop = 2
opt.shiftwidth = 2
opt.expandtab = true
opt.smartindent = true
opt.autoindent = true
opt.smarttab = true

-- UI
opt.number = true
opt.relativenumber = true
opt.cursorline = true
opt.signcolumn = "yes"
opt.termguicolors = true
opt.showmode = false
opt.wildmode = "longest:full,full"

-- Search
opt.ignorecase = true
opt.smartcase = true
opt.hlsearch = true
opt.incsearch = true

-- Scrolling
opt.scrolloff = 8
opt.sidescrolloff = 8

-- Mouse / clipboard
opt.mouse = "a"
opt.clipboard = "unnamedplus"

-- Whitespace display
opt.list = true
opt.listchars = { tab = "→ ", trail = "·", extends = ">", precedes = "<" }
opt.fillchars = { vert = "│", fold = "─", eob = " " }

-- Folding
opt.foldenable = false
opt.foldmethod = "indent"
opt.foldlevel = 99

-- Responsiveness
opt.updatetime = 300
opt.timeoutlen = 300 -- short so which-key pops quickly

-- Splits
opt.splitright = true
opt.splitbelow = true

-- Persistence
opt.undofile = true
opt.swapfile = false

-- Messages
opt.shortmess:append("c")

-- Built-in treesitter (nvim 0.11+): highlight when a parser exists,
-- silently fall back to regex syntax when it doesn't
vim.api.nvim_create_autocmd("FileType", {
  callback = function(args)
    pcall(vim.treesitter.start, args.buf)
  end,
})
