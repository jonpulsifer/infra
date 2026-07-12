return {
  -- Fuzzy finder
  {
    "echasnovski/mini.pick",
    dependencies = { "nvim-tree/nvim-web-devicons" },
    keys = {
      { "<leader>ff", function() require("mini.pick").builtin.files() end, desc = "find files" },
      { "<leader>fg", function() require("mini.pick").builtin.grep_live() end, desc = "live grep" },
      { "<leader>fb", function() require("mini.pick").builtin.buffers() end, desc = "find buffers" },
      { "<leader>fh", function() require("mini.pick").builtin.help() end, desc = "find help" },
      { "<leader>fr", function() require("mini.pick").builtin.resume() end, desc = "resume last picker" },
      { "<leader><leader>", function() require("mini.pick").builtin.buffers() end, desc = "find buffers" },
    },
    opts = {},
  },

  -- File tree sidebar
  {
    "nvim-neo-tree/neo-tree.nvim",
    branch = "v3.x",
    dependencies = {
      "nvim-lua/plenary.nvim",
      "MunifTanjim/nui.nvim",
      "nvim-tree/nvim-web-devicons",
    },
    keys = {
      { "<leader>e", ":Neotree toggle<CR>", desc = "toggle file explorer" },
    },
    opts = {
      close_if_last_window = true,
      filesystem = {
        follow_current_file = { enabled = true },
        -- oil owns directory buffers (default_file_explorer below)
        hijack_netrw_behavior = "disabled",
      },
      default_component_configs = {
        git_status = {
          symbols = {
            added = "",
            modified = "",
            deleted = "",
            renamed = "",
            untracked = "",
            ignored = "",
            unstaged = "",
            staged = "",
            conflict = "",
          },
        },
      },
    },
  },

  -- Edit directories as buffers
  {
    "stevearc/oil.nvim",
    dependencies = { "nvim-tree/nvim-web-devicons" },
    keys = {
      { "-", "<CMD>Oil<CR>", desc = "open parent directory" },
    },
    opts = {
      default_file_explorer = true,
      view_options = {
        show_hidden = true,
      },
    },
  },

  -- Buffer line / tabs
  {
    "akinsho/bufferline.nvim",
    version = "*",
    dependencies = { "nvim-tree/nvim-web-devicons" },
    event = "VeryLazy",
    keys = {
      { "[b", "<CMD>BufferLineCyclePrev<CR>", desc = "prev buffer" },
      { "]b", "<CMD>BufferLineCycleNext<CR>", desc = "next buffer" },
    },
    opts = {
      options = {
        diagnostics = "nvim_lsp",
        separator_style = "slant",
        offsets = {
          {
            filetype = "neo-tree",
            text = "File Explorer",
            highlight = "Directory",
            text_align = "left",
          },
        },
      },
    },
  },
}
