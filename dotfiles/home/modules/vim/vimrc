" Modern Vim Configuration
set nocompatible              " Disable vi compatibility mode
set encoding=utf-8            " Set UTF-8 encoding
filetype plugin indent on     " Enable file type detection, plugins, and indentation

" Theme and Visual Settings
set background=dark           " Use dark background
syntax on                     " Enable syntax highlighting
colorscheme sorbet            " Use One Dark theme (widely available and readable)
set termguicolors             " Enable true color support

" Editor Behavior
set autoindent                " Copy indent from current line when starting new line
set smartindent               " Do smart autoindenting when starting a new line
set tabstop=2                 " Number of spaces that a <Tab> in the file counts for
set shiftwidth=2              " Number of spaces to use for each step of (auto)indent
set expandtab                 " Use spaces instead of tabs
set smarttab                  " Use 'shiftwidth' when inserting <Tab>
set number                    " Show line numbers
set relativenumber            " Show relative line numbers
set cursorline                " Highlight the screen line of the cursor
" set cursorcolumn              " Highlight the screen column of the cursor
set showmatch                 " Show matching brackets/parentheses
set matchtime=2               " Tenths of a second to show the matching paren
set ignorecase                " Ignore case in search patterns
set smartcase                 " Override 'ignorecase' if pattern contains uppercase
set hlsearch                  " Highlight all matches of the last search pattern
set incsearch                 " Show where the pattern matches as it is typed
set scrolloff=8               " Keep 8 lines above/below cursor when scrolling
set sidescrolloff=8           " Keep 8 characters left/right of cursor when scrolling
set mouse=a                   " Enable mouse support in all modes
set clipboard+=unnamedplus    " Use system clipboard for all operations
set backspace=indent,eol,start " Allow backspacing over everything in insert mode
set whichwrap+=<,>,[,]        " Allow specified keys to move to the previous/next line
set list                      " Show invisible characters
set listchars=tab:→\ ,trail:·,extends:>,precedes:<,space:· " Define how to show invisible characters
set fillchars=vert:│,fold:─    " Define how to show vertical splits and folds
set nofoldenable              " Disable folding by default
set foldmethod=indent         " Fold based on indentation
set foldlevel=99              " Don't fold anything by default
set signcolumn=yes            " Always show the sign column
" set colorcolumn=80,100        " Show vertical lines at 80 and 100 characters
set laststatus=2              " Always show status line
set showcmd                   " Show (partial) command in status line
set wildmenu                  " Show command-line completion in a menu
set wildmode=list:longest,full " Command-line completion mode
set wildignore=*.o,*.obj,*.bak,*.exe,*.py[co],*.swp,*~,*.so,*.zip,*.tar.gz,*.tar.bz2 " Files to ignore in wildmenu
set ttimeoutlen=100           " Time in milliseconds to wait for a key code
set updatetime=300            " Time in milliseconds to wait before triggering CursorHold
set shortmess+=c              " Don't show completion messages
set noshowmode                " Don't show mode in status line (for statusline plugins)
set hidden                    " Hide buffers instead of closing them
set nobackup                  " Don't create backup files
set nowritebackup             " Don't create backup files while editing
set noswapfile                " Don't create swap files
set undofile                  " Save undo history to a file
set undodir=~/.vim/undodir    " Directory to store undo history
set undolevels=1000           " Maximum number of changes that can be undone
set undoreload=10000          " Maximum number of lines to save for undo on a buffer reload

" VSCode-like Keybindings
nnoremap <C-s> :w<CR>         " Save file
inoremap <C-s> <Esc>:w<CR>a   " Save file in insert mode
nnoremap <C-f> /              " Search
inoremap <C-f> <Esc>/         " Search in insert mode
nnoremap <C-h> :nohlsearch<CR> " Clear search highlighting
nnoremap <C-z> u              " Undo
inoremap <C-z> <Esc>ua        " Undo in insert mode
nnoremap <C-y> <C-r>          " Redo
inoremap <C-y> <Esc><C-r>a    " Redo in insert mode
nnoremap <C-a> ggVG           " Select all
inoremap <C-a> <Esc>ggVGa     " Select all in insert mode
nnoremap <C-c> "+y            " Copy to system clipboard
vnoremap <C-c> "+y            " Copy selection to system clipboard
nnoremap <C-v> "+p            " Paste from system clipboard
inoremap <C-v> <Esc>"+pa      " Paste from system clipboard in insert mode
nnoremap <C-x> "+d            " Cut to system clipboard
vnoremap <C-x> "+d            " Cut selection to system clipboard
nnoremap <C-w> :bd<CR>        " Close current buffer
nnoremap <C-t> :tabnew<CR>    " New tab
nnoremap <C-Tab> :tabnext<CR> " Next tab
nnoremap <C-S-Tab> :tabprevious<CR> " Previous tab
nnoremap <C-n> :bn<CR>        " Next buffer
nnoremap <C-p> :bp<CR>        " Previous buffer

" Window Management
nnoremap <C-h> <C-w>h         " Move to left window
nnoremap <C-j> <C-w>j         " Move to window below
nnoremap <C-k> <C-w>k         " Move to window above
nnoremap <C-l> <C-w>l         " Move to right window
nnoremap <C-Up> <C-w>+        " Increase window height
nnoremap <C-Down> <C-w>-      " Decrease window height
nnoremap <C-Left> <C-w><      " Decrease window width
nnoremap <C-Right> <C-w>>     " Increase window width

" Plugin Settings
let g:terraform_fmt_on_save = 1 " Format Terraform files on save
let g:go_version_warning = 0    " Disable Go version warning

" Auto Commands
augroup vimrc
  autocmd!
  " Return to last edit position when opening files
  autocmd BufReadPost *
    \ if line("'\"") > 0 && line("'\"") <= line("$") |
    \   exe "normal! g`\"" |
    \ endif

  " Strip trailing whitespace
  autocmd BufWritePre * :call <SID>StripTrailingWhitespaces()
augroup END

" Functions
function! <SID>StripTrailingWhitespaces()
  let l = line(".")
  let c = col(".")
  %s/\s\+$//e
  call cursor(l, c)
endfunction

" Show current git repo name and branch in statusline
function! MyGitRepoBranchStatusline()
  let l:git_dir = system('git rev-parse --show-toplevel 2>/dev/null')
  if v:shell_error
    return ''
  endif
  let l:repo_name = fnamemodify(substitute(l:git_dir, '\n$', '', ''), ':t')
  let l:branch = system('git rev-parse --abbrev-ref HEAD 2>/dev/null')
  if v:shell_error
    return l:repo_name
  endif
  let l:branch = substitute(l:branch, '\n$', '', '')
  if l:branch == 'HEAD'
    return l:repo_name . '  detached'
  endif
  return l:repo_name . '  ' . l:branch
endfunction

" Show file size in statusline
function! MyFileSizeStatusline()
  if !filereadable(expand('%:p'))
    return ''
  endif
  let l:size = getfsize(expand('%:p'))
  if l:size < 0
    return ''
  elseif l:size < 1024
    return l:size . 'B'
  elseif l:size < 1024*1024
    return printf('%.1fK', l:size/1024.0)
  elseif l:size < 1024*1024*1024
    return printf('%.1fM', l:size/1024.0/1024.0)
  else
    return printf('%.1fG', l:size/1024.0/1024.0/1024.0)
  endif
endfunction

" Show current mode in statusline
function! MyModeStatusline()
  let l:m = mode()
  return l:m ==# 'n' ? 'NORMAL' :
        \ l:m ==# 'i' ? 'INSERT' :
        \ l:m ==# 'R' ? 'REPLACE' :
        \ l:m ==# 'v' ? 'VISUAL' :
        \ l:m ==# 'V' ? 'V-LINE' :
        \ l:m ==# '\x16' ? 'V-BLOCK' :
        \ l:m ==# 'c' ? 'COMMAND' :
        \ l:m ==# 't' ? 'TERMINAL' :
        \ l:m ==# 's' ? 'SELECT' :
        \ l:m ==# 'S' ? 'S-LINE' :
        \ l:m ==# '\x13' ? 'S-BLOCK' :
        \ l:m ==# '!' ? 'SHELL' :
        \ l:m ==# 'r' ? 'PROMPT' :
        \ l:m ==# 'rm' ? 'MORE' :
        \ l:m ==# 'r?' ? 'CONFIRM' :
        \ l:m ==# 'cv' ? 'VIM EX' :
        \ l:m ==# 'ce' ? 'EX' :
        \ l:m ==# 'ni' ? 'N-PENDING' :
        \ l:m ==# 'no' ? 'OP-PENDING' :
        \ l:m ==# 'nov' ? 'OP-PENDING' :
        \ l:m ==# 'niV' ? 'N-PENDING' :
        \ l:m ==# 'niR' ? 'N-PENDING' :
        \ l:m ==# 'Rv' ? 'V-REPLACE' :
        \ l:m ==# 'r' ? 'HIT-ENTER' :
        \ l:m ==# 'rm' ? 'MORE' :
        \ l:m ==# 'r?' ? 'CONFIRM' :
        \ l:m ==# '!' ? 'SHELL' :
        \ 'UNKNOWN'
endfunction

" Enhanced Status Line with repo name and better spacing
set statusline=
set statusline+=%#StatusLineNC#%{MyModeStatusline()}%#StatusLine#\  " Mode
set statusline+=%#StatusLineNC#%{MyGitRepoBranchStatusline()}%#StatusLine#\  " Git info
set statusline+=%#StatusLineNC#%{&modified?'[+]':''}%{&readonly?'[RO]':''}%#StatusLine#\  " Modified/Readonly
set statusline+=%#StatusLineNC#%f%#StatusLine#\  " Filename
set statusline+=%#StatusLineNC#%{&filetype!=''?'['.&filetype.']':''}%#StatusLine#\  " Filetype
set statusline+=%#StatusLineNC#%{MyFileSizeStatusline()}%#StatusLine#  " File size
set statusline+=%=  " Switch to right side
set statusline+=%#StatusLineNC#%{&fileformat}%#StatusLine#  " File format
set statusline+=\ %#StatusLineNC#%{&fileencoding}%#StatusLine#  " File encoding
set statusline+=\ %#StatusLineNC#%l/%L:%v%#StatusLine#  " Line/Column info
set statusline+=\ %#StatusLineNC#%P%#StatusLine#  " Percentage through file

" Status line colors
hi StatusLine   ctermfg=231 ctermbg=238 guifg=#f8f8f2 guibg=#44475a
hi StatusLineNC ctermfg=231 ctermbg=238 guifg=#6272a4 guibg=#44475a

" Terminal Settings
if has('nvim')
  tnoremap <Esc> <C-\><C-n>   " Escape terminal mode
  tnoremap <C-h> <C-\><C-n><C-w>h " Navigate left in terminal
  tnoremap <C-j> <C-\><C-n><C-w>j " Navigate down in terminal
  tnoremap <C-k> <C-\><C-n><C-w>k " Navigate up in terminal
  tnoremap <C-l> <C-\><C-n><C-w>l " Navigate right in terminal
endif

" Tmux Integration
if $TMUX == ''
  set clipboard+=unnamed      " Use system clipboard when not in tmux
endif

" Language-specific settings
augroup filetype_specific
  autocmd!
  " Git commit messages
  autocmd FileType gitcommit setlocal textwidth=72  " Wrap at 72 characters
  autocmd FileType gitcommit setlocal spell         " Enable spell checking
  
  " Markdown
  autocmd FileType markdown setlocal spell          " Enable spell checking
  autocmd FileType markdown setlocal textwidth=80   " Wrap at 80 characters
  
  " Python
  autocmd FileType python setlocal tabstop=4        " Use 4 spaces for tabs
  autocmd FileType python setlocal shiftwidth=4     " Use 4 spaces for indentation
  
  " JavaScript/TypeScript
  autocmd FileType javascript,typescript setlocal tabstop=2    " Use 2 spaces for tabs
  autocmd FileType javascript,typescript setlocal shiftwidth=2 " Use 2 spaces for indentation
  
  " YAML
  autocmd FileType yaml setlocal tabstop=2          " Use 2 spaces for tabs
  autocmd FileType yaml setlocal shiftwidth=2       " Use 2 spaces for indentation
augroup END
