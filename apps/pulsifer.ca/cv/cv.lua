-- pandoc Lua filter: turn the CV's heading conventions into typst calls
-- defined in cv.typ. Presentation only; no copy is changed.

local function typst(inlines)
  local s = pandoc.write(pandoc.Pandoc({pandoc.Plain(inlines)}), 'typst', {wrap_text = 'none'})
  return (s:gsub('%s+$', ''))
end

local function typst_blocks(blocks)
  local s = pandoc.write(pandoc.Pandoc(blocks), 'typst', {wrap_text = 'none'})
  return (s:gsub('%s+$', ''))
end

local function raw(s) return pandoc.RawBlock('typst', s) end

-- "Employer, 2021-current" -> inlines, "2021–current"
local function split_date(inlines)
  local ils = pandoc.List(inlines)
  local last = ils[#ils]
  if not (last and last.t == 'Str' and (last.text:match('^%d%d%d%d%-%w+$') or last.text:match('^%d%d%d%d$'))) then
    return ils, nil
  end
  local date = last.text:gsub('%-', '\u{2013}')
  ils:remove(#ils)
  if ils[#ils].t == 'Space' then ils:remove(#ils) end
  local prev = ils[#ils]
  if prev.t == 'Str' then
    if prev.text == ',' then ils:remove(#ils) else prev.text = prev.text:gsub(',$', '') end
  end
  return ils, date
end

-- spaced hyphen between words and yyyy-yyyy ranges -> en dash
local function dashes(inlines)
  for _, il in ipairs(inlines) do
    if il.t == 'Str' then
      if il.text == '-' then il.text = '\u{2013}'
      else il.text = il.text:gsub('(%d%d%d%d)%-(%d%d%d%d)', '%1\u{2013}%2') end
    end
  end
  return inlines
end

local function is_achievements(h)
  return pandoc.utils.stringify(h):match('^Positional Achievements') ~= nil
end

-- Glue the last two words of a run of inlines with a non-breaking space so
-- no paragraph or list item ends on a lone word.
local containers = { Link = true, Strong = true, Emph = true, Span = true, Quoted = true }
local function has_space(ils)
  for _, il in ipairs(ils) do if il.t == 'Space' then return true end end
  return false
end
local function glue(ils)
  local j
  for i = #ils, 1, -1 do
    if ils[i].t == 'RawInline' then return end
    if ils[i].t == 'Space' then j = i break end
  end
  for i = #ils, j or 1, -1 do
    local il = ils[i]
    if containers[il.t] and has_space(il.content) then return glue(il.content) end
  end
  if not j then return end
  local k = j - 1
  while k > 1 and ils[k - 1].t ~= 'Space' do k = k - 1 end
  local head, tail = pandoc.List({}), pandoc.List({})
  for i = k, j - 1 do head:insert(ils[i]) end
  for i = j + 1, #ils do tail:insert(ils[i]) end
  for i = #ils, k, -1 do ils:remove(i) end
  ils:insert(pandoc.RawInline('typst', '#[' .. typst(head) .. '~' .. typst(tail) .. ']'))
end

-- loose achievement bullets: "Title\n  body" -> #achievement[title][body]
local function split_item(blocks)
  local first = blocks[1]
  if not first or (first.t ~= 'Para' and first.t ~= 'Plain') then return nil end
  local ils = first.content
  local at
  for i, il in ipairs(ils) do if il.t == 'SoftBreak' then at = i break end end
  if not at then return nil end
  local title = pandoc.List({})
  for i = 1, at - 1 do title:insert(ils[i]) end
  local body = pandoc.List({})
  for i = at + 1, #ils do body:insert(ils[i]) end
  glue(body)
  return raw('#achievement[' .. typst(dashes(title)) .. '][' .. typst(body) .. ']')
end

local twoup_sections = { ['Courses, Competitions, Training, and Education'] = true, ['Talks'] = true }

local keep_sections = { ['Community, Memberships, & Volunteering'] = true, ['Courses, Competitions, Training, and Education'] = true, Talks = true, Publications = true }

function Pandoc(doc)
  local all = pandoc.List({})
  local out = all
  local blocks = doc.blocks
  local prev_section, last_org
  local function flush()
    if out ~= all then all:insert(raw('#keep[\n' .. typst_blocks(out) .. '\n]')) end
    out = all
  end
  for i, b in ipairs(blocks) do
    local nxt = blocks[i + 1]
    if b.t == 'Header' then
      local level = b.level
      if level == 2 then
        flush()
        prev_section = pandoc.utils.stringify(b)
        all:insert(raw('#section[' .. typst(b.content) .. ']'))
        if keep_sections[prev_section] then out = pandoc.List({}) end
      elseif is_achievements(b) then
        out:insert(raw('#achievements[' .. pandoc.utils.stringify(b):gsub(':$', '') .. ']'))
      elseif level == 3 then
        last_org = nil
        local name, date = split_date(b.content)
        out:insert(raw('#employer[' .. typst(name) .. '][' .. (date or '') .. ']'))
      elseif level == 4 and nxt and nxt.t == 'Header' and nxt.level == 5 then
        local name = pandoc.utils.stringify(b)
        if name ~= last_org then out:insert(raw('#org[' .. typst(b.content) .. ']')) end
        last_org = name
      else
        local title, date = split_date(b.content)
        out:insert(raw('#role[' .. typst(dashes(title)) .. '][' .. (date or '') .. ']'))
      end
    elseif b.t == 'Para' and prev_section == 'Summary' and blocks[i - 1].t == 'Header' then
      out:insert(raw('#lede[' .. typst(b.content) .. ']'))
    elseif b.t == 'BulletList' then
      local awards = pandoc.List({})
      for _, item in ipairs(b.content) do
        local a = split_item(item)
        if a then awards:insert(a) end
      end
      if #awards == #b.content then
        out:extend(awards)
      elseif twoup_sections[prev_section] then
        -- balance by estimated line count (~40 chars per column line)
        local lines = function(item) return math.ceil(#pandoc.utils.stringify(item) / 40) end
        local total, best, best_diff, acc = 0, 0, math.huge, 0
        for _, item in ipairs(b.content) do total = total + lines(item) end
        for n, item in ipairs(b.content) do
          acc = acc + lines(item)
          local diff = math.abs(acc - (total - acc))
          if diff < best_diff then best, best_diff = n, diff end
        end
        local a, c = pandoc.List({}), pandoc.List({})
        for n, item in ipairs(b.content) do
          if n <= best then a:insert(item) else c:insert(item) end
        end
        out:insert(raw('#twoup[\n' .. typst_blocks({pandoc.BulletList(a)}) .. '\n][\n' .. typst_blocks({pandoc.BulletList(c)}) .. '\n]'))
      else
        out:insert(b)
      end
    else
      out:insert(b)
    end
  end
  flush()
  return pandoc.Pandoc(all, doc.meta)
end

function Para(p) glue(p.content) return p end
function Plain(p)
  if not p.content:find_if(function(il) return il.t == 'SoftBreak' end) then glue(p.content) end
  return p
end
