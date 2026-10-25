-- :LexCode opens the LexCode board (`lexcode tui`) in a tab, or jumps back to the one already running.
-- Claude panes then open as splits in this Neovim. Install: lazy.nvim { dir = '<LexCode repo>/nvim' }, or add the
-- folder to 'runtimepath'.
if vim.g.loaded_lexcode then return end
vim.g.loaded_lexcode = true

-- `lexcode` on PATH, else the newest LexCode extension's bundled CLI.
local function command()
  if vim.fn.executable('lexcode') == 1 then return { 'lexcode', 'tui' } end
  local found = vim.fn.glob(vim.fn.expand('~') .. '/.*/extensions/lex.lex-code-*/out/cli.js', false, true)
  table.sort(found, function(a, b) return vim.fn.getftime(a) > vim.fn.getftime(b) end)
  if found[1] then return { 'node', found[1], 'tui' } end
end

vim.api.nvim_create_user_command('LexCode', function()
  for _, tab in ipairs(vim.api.nvim_list_tabpages()) do
    for _, win in ipairs(vim.api.nvim_tabpage_list_wins(tab)) do
      if vim.b[vim.api.nvim_win_get_buf(win)].lexcode_board then
        vim.api.nvim_set_current_tabpage(tab)
        vim.api.nvim_set_current_win(win)
        vim.cmd('startinsert')
        return
      end
    end
  end
  local cmd = command()
  if not cmd then
    vim.notify('LexCode: install the CLI (npm install -g github:buffer808/LexCode) or the VS Code extension', vim.log.levels.ERROR)
    return
  end
  vim.cmd('tabnew')
  if vim.fn.has('nvim-0.11') == 1 then vim.fn.jobstart(cmd, { term = true }) else vim.fn.termopen(cmd) end
  vim.b.lexcode_board = true
  vim.cmd('startinsert')
end, { desc = 'Open the LexCode board' })
