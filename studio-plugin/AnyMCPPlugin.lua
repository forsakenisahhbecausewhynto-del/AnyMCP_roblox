
--[[
    AnyMCP for Roblox Studio
    Version: 0.2.0

    Features:
      - Native Studio toolbar button and dockable control panel
      - Localhost-only bridge URL validation
      - Connect / disconnect controls
      - Server health check
      - Automatic heartbeat and command polling
      - Bounded, read-only game hierarchy inspection
      - Read-only current selection inspection
      - No automatic changes to the game
      - Session token is not stored in plugin settings

    Compatible with the AnyMCP Node bridge endpoints:
      GET  /health
      POST /heartbeat
      GET  /next
      POST /result
]]

assert(plugin, "AnyMCP must run as a Roblox Studio plugin.")

local HttpService = game:GetService("HttpService")
local Selection = game:GetService("Selection")

-- Configuration
local DEFAULT_URL = "http://127.0.0.1:39271"
local POLL_INTERVAL = 1
local HEARTBEAT_INTERVAL = 5
local MAX_TREE_DEPTH = 5
local MAX_TREE_ITEMS = 250
local MAX_RESPONSE_LENGTH = 1000

local COLORS = {
    background = Color3.fromRGB(27, 29, 35),
    panel = Color3.fromRGB(37, 40, 48),
    input = Color3.fromRGB(46, 49, 59),
    text = Color3.fromRGB(238, 240, 245),
    muted = Color3.fromRGB(170, 176, 188),
    accent = Color3.fromRGB(73, 130, 230),
    success = Color3.fromRGB(112, 208, 143),
    warning = Color3.fromRGB(245, 190, 85),
    error = Color3.fromRGB(245, 112, 112),
}

-- Runtime state. The token is intentionally memory-only.
local baseUrl = DEFAULT_URL
local activeToken = nil
local running = false
local loopVersion = 0

local function trim(value)
    return tostring(value or ""):match("^%s*(.-)%s*$")
end

local function shortText(value, maxLength)
    local text = tostring(value or "")
    text = text:gsub("[\r\n]+", " ")
    return text:sub(1, maxLength or MAX_RESPONSE_LENGTH)
end

-- Only HTTP loopback addresses are accepted.
-- This prevents accidentally forwarding project information to a remote host.
local function validateBaseUrl(value)
    value = trim(value):gsub("/+$", "")

    local host, portText = value:match("^http://([%w%.%-]+):(%d+)$")

    if not host or not portText then
        return nil, "Use http://127.0.0.1:39271 or http://localhost:39271."
    end

    host = string.lower(host)

    if host ~= "127.0.0.1" and host ~= "localhost" then
        return nil, "For safety, the bridge must run on this computer."
    end

    local port = tonumber(portText)
    if not port or port < 1 or port > 65535 then
        return nil, "The port must be between 1 and 65535."
    end

    return "http://" .. host .. ":" .. tostring(port)
end

-- HTTP helper:
-- requireToken=false is used only for the server's /health endpoint.
local function httpRequest(method, path, body, requireToken)
    local headers = {
        ["Content-Type"] = "application/json",
    }

    if requireToken ~= false then
        if not activeToken or activeToken == "" then
            return nil, "No session token is configured."
        end

        headers["X-AnyMCP-Token"] = activeToken
    end

    local options = {
        Url = baseUrl .. path,
        Method = method,
        Headers = headers,
    }

    if body ~= nil then
        local encodeOk, encoded = pcall(function()
            return HttpService:JSONEncode(body)
        end)

        if not encodeOk then
            return nil, "Could not encode request body."
        end

        options.Body = encoded
    end

    local requestOk, response = pcall(function()
        return HttpService:RequestAsync(options)
    end)

    if not requestOk then
        return nil, shortText(response)
    end

    if not response.Success then
        return nil, "HTTP " .. tostring(response.StatusCode)
            .. ": " .. shortText(response.Body, 240)
    end

    if not response.Body or response.Body == "" then
        return {}, nil
    end

    local decodeOk, decoded = pcall(function()
        return HttpService:JSONDecode(response.Body)
    end)

    if not decodeOk then
        return nil, "The bridge returned invalid JSON."
    end

    return decoded, nil
end

-- UI construction
local toolbar = plugin:CreateToolbar("AnyMCP")
local toolbarButton = toolbar:CreateButton(
    "OpenAnyMCP",
    "Open the AnyMCP Roblox bridge panel",
    "",
    "AnyMCP"
)
toolbarButton.ClickableWhenViewportHidden = true

local savedUrl = plugin:GetSetting("baseUrl")
if type(savedUrl) == "string" then
    local validated = validateBaseUrl(savedUrl)
    if validated then
        baseUrl = validated
    end
end

local widgetInfo = DockWidgetPluginGuiInfo.new(
    Enum.InitialDockState.Right,
    false,
    false,
    380,
    500,
    320,
    360
)

local widget = plugin:CreateDockWidgetPluginGuiAsync(
    "AnyMCPRobloxWidgetV1",
    widgetInfo
)
widget.Title = "AnyMCP - Roblox Studio"

local function makeInstance(className, properties, parent)
    local object = Instance.new(className)

    for property, value in pairs(properties) do
        object[property] = value
    end

    object.Parent = parent
    return object
end

local scroll = makeInstance("ScrollingFrame", {
    Name = "Content",
    Size = UDim2.fromScale(1, 1),
    CanvasSize = UDim2.new(0, 0, 0, 0),
    AutomaticCanvasSize = Enum.AutomaticSize.Y,
    ScrollBarThickness = 6,
    BorderSizePixel = 0,
    BackgroundColor3 = COLORS.background,
}, widget)

local content = makeInstance("Frame", {
    Name = "ContentFrame",
    Position = UDim2.new(0, 12, 0, 12),
    Size = UDim2.new(1, -24, 0, 0),
    AutomaticSize = Enum.AutomaticSize.Y,
    BackgroundTransparency = 1,
}, scroll)

makeInstance("UIPadding", {
    PaddingBottom = UDim.new(0, 12),
}, content)

local layout = makeInstance("UIListLayout", {
    Padding = UDim.new(0, 8),
    SortOrder = Enum.SortOrder.LayoutOrder,
}, content)

local layoutOrder = 0

local function orderObject(object)
    layoutOrder += 1
    object.LayoutOrder = layoutOrder
    return object
end

local function makeLabel(text, size, color, bold)
    return orderObject(makeInstance("TextLabel", {
        Size = UDim2.new(1, 0, 0, 0),
        AutomaticSize = Enum.AutomaticSize.Y,
        BackgroundTransparency = 1,
        Font = bold and Enum.Font.GothamSemibold or Enum.Font.Gotham,
        Text = text,
        TextColor3 = color or COLORS.text,
        TextSize = size or 13,
        TextWrapped = true,
        TextXAlignment = Enum.TextXAlignment.Left,
        TextYAlignment = Enum.TextYAlignment.Center,
    }, content))
end

local function makeTextBox(placeholder, initialText, clearOnFocus)
    return orderObject(makeInstance("TextBox", {
        Size = UDim2.new(1, 0, 0, 36),
        BackgroundColor3 = COLORS.input,
        BorderSizePixel = 0,
        ClearTextOnFocus = clearOnFocus or false,
        Font = Enum.Font.Code,
        PlaceholderText = placeholder,
        PlaceholderColor3 = COLORS.muted,
        Text = initialText or "",
        TextColor3 = COLORS.text,
        TextSize = 12,
        TextXAlignment = Enum.TextXAlignment.Left,
    }, content))
end

local function makeButton(text)
    local button = makeInstance("TextButton", {
        Size = UDim2.new(1, 0, 0, 36),
        BackgroundColor3 = COLORS.accent,
        BorderSizePixel = 0,
        AutoButtonColor = true,
        Font = Enum.Font.GothamSemibold,
        Text = text,
        TextColor3 = Color3.new(1, 1, 1),
        TextSize = 13,
    }, content)

    orderObject(button)
    return button
end

makeLabel("AnyMCP • Roblox Studio", 20, COLORS.text, true)
makeLabel(
    "Connect your local MCP server to Studio. This plugin supports "
    .. "read-only hierarchy and selection tools.",
    12,
    COLORS.muted
)

local statusLabel = makeLabel(
    "Status: Disconnected",
    13,
    COLORS.warning,
    true
)

makeLabel("Local bridge URL", 12, COLORS.text, true)
local urlBox = makeTextBox(
    "http://127.0.0.1:39271",
    baseUrl,
    false
)

makeLabel("Session token", 12, COLORS.text, true)
local tokenBox = makeTextBox(
    "Paste the token printed by the Node server",
    "",
    false
)

makeLabel(
    "The token is used for this session only and is not saved "
    .. "by this plugin. Only loopback URLs are accepted.",
    11,
    COLORS.muted
)

local testButton = makeButton("Test local server")
local connectButton = makeButton("Connect to bridge")

makeLabel("Supported commands", 13, COLORS.text, true)
makeLabel(
    "• studio_status — check whether Studio is connected\n"
    .. "• get_game_tree — read a bounded hierarchy summary\n"
    .. "• get_selection — read the current Studio selection",
    12,
    COLORS.muted
)
makeLabel(
    "This version does not edit, delete, or execute game content.",
    11,
    COLORS.muted
)

local function setStatus(message, color)
    statusLabel.Text = "Status: " .. tostring(message)
    statusLabel.TextColor3 = color or COLORS.muted
end

-- Allowlisted roots. The AI cannot provide arbitrary Lua expressions
-- or paths to execute in the Studio process.
local ROOTS = {
    ["game"] = function()
        return game
    end,

    ["game.Workspace"] = function()
        return workspace
    end,

    ["game.ReplicatedStorage"] = function()
        return game:GetService("ReplicatedStorage")
    end,

    ["game.ServerStorage"] = function()
        return game:GetService("ServerStorage")
    end,

    ["game.ServerScriptService"] = function()
        return game:GetService("ServerScriptService")
    end,

    ["game.StarterGui"] = function()
        return game:GetService("StarterGui")
    end,

    ["game.StarterPlayer"] = function()
        return game:GetService("StarterPlayer")
    end,

    ["game.Lighting"] = function()
        return game:GetService("Lighting")
    end,

    ["game.ReplicatedFirst"] = function()
        return game:GetService("ReplicatedFirst")
    end,

    ["game.SoundService"] = function()
        return game:GetService("SoundService")
    end,
}

local function describeInstance(instance)
    return {
        name = instance.Name,
        className = instance.ClassName,
        path = instance:GetFullName(),
    }
end

local function getGameTree(root, depth, maxDepth, budget)
    if budget.count >= budget.maxItems then
        return nil
    end

    budget.count += 1

    local node = describeInstance(root)
    node.children = {}

    if depth >= maxDepth then
        return node
    end

    local childrenOk, children = pcall(function()
        return root:GetChildren()
    end)

    if not childrenOk then
        return node
    end

    for _, child in ipairs(children) do
        if budget.count >= budget.maxItems then
            break
        end

        local childNode = getGameTree(
            child,
            depth + 1,
            maxDepth,
            budget
        )

        if childNode then
            table.insert(node.children, childNode)
        end
    end

    return node
end

local function boundedInteger(value, defaultValue, minimum, maximum)
    if type(value) ~= "number" then
        return defaultValue
    end

    return math.clamp(math.floor(value), minimum, maximum)
end

local function handleCommand(command)
    if type(command) ~= "table" then
        error("Invalid command.")
    end

    if command.action == "get_selection" then
        local selected = {}

        for _, instance in ipairs(Selection:Get()) do
            table.insert(selected, describeInstance(instance))
        end

        return selected

    elseif command.action == "get_game_tree" then
        local args = type(command.args) == "table"
            and command.args
            or {}

        local path = type(args.path) == "string"
            and args.path
            or "game"

        local rootGetter = ROOTS[path]
        if not rootGetter then
            error("Unsupported root path: " .. shortText(path, 120))
        end

        local root = rootGetter()

        local maxDepth = boundedInteger(
            args.maxDepth,
            4,
            0,
            MAX_TREE_DEPTH
        )

        local maxItems = boundedInteger(
            args.maxItems,
            200,
            1,
            MAX_TREE_ITEMS
        )

        return getGameTree(root, 0, maxDepth, {
            count = 0,
            maxItems = maxItems,
        })
    end

    error("Unsupported command: " .. shortText(command.action, 100))
end

local function sendCommandResult(command)
    if type(command) ~= "table"
        or type(command.id) ~= "string"
        or type(command.action) ~= "string" then
        return
    end

    local ok, result = pcall(function()
        return handleCommand(command)
    end)

    local payload = {
        id = command.id,
    }

    if ok then
        payload.result = result
    else
        payload.error = shortText(result)
        warn("[AnyMCP] Command failed:", payload.error)
    end

    local response, err = httpRequest(
        "POST",
        "/result",
        payload,
        true
    )

    if not response then
        warn("[AnyMCP] Could not return command result:", err)
        setStatus("Could not send command result; retry connection.", COLORS.error)
    end
end

local function stopBridge()
    running = false
    loopVersion += 1
    activeToken = nil

    connectButton.Text = "Connect to bridge"
    setStatus("Disconnected", COLORS.warning)

    print("[AnyMCP] Bridge disconnected.")
end

local function startBridge()
    local validatedUrl, urlError = validateBaseUrl(urlBox.Text)

    if not validatedUrl then
        setStatus(urlError, COLORS.error)
        return
    end

    local token = trim(tokenBox.Text)

    if token == "" then
        setStatus("Paste the session token from the Node server.", COLORS.error)
        return
    end

    baseUrl = validatedUrl
    activeToken = token

    -- Persist only the loopback URL, never the token.
    pcall(function()
        plugin:SetSetting("baseUrl", baseUrl)
    end)

    setStatus("Checking local server...", COLORS.muted)

    local health, healthError = httpRequest(
        "GET",
        "/health",
        nil,
        false
    )

    if not health or health.ok ~= true then
        activeToken = nil
        setStatus(
            "Server unreachable: " .. shortText(healthError or "Unexpected response"),
            COLORS.error
        )
        return
    end

    local heartbeat, heartbeatError = httpRequest(
        "POST",
        "/heartbeat",
        {
            placeName = game.Name,
            gameId = tostring(game.PlaceId),
        },
        true
    )

    if not heartbeat then
        activeToken = nil
        setStatus(
            "Heartbeat failed: " .. shortText(heartbeatError),
            COLORS.error
        )
        return
    end

    running = true
    loopVersion += 1
    local thisVersion = loopVersion

    connectButton.Text = "Disconnect"
    setStatus("Connected. Waiting for MCP commands.", COLORS.success)

    print("[AnyMCP] Connected to local bridge at " .. baseUrl)

    -- Heartbeat worker
    task.spawn(function()
        while running and loopVersion == thisVersion do
            local response, err = httpRequest(
                "POST",
                "/heartbeat",
                {
                    placeName = game.Name,
                    gameId = tostring(game.PlaceId),
                },
                true
            )

            if not response then
                setStatus(
                    "Heartbeat error; retrying: " .. shortText(err, 150),
                    COLORS.error
                )
            else
                setStatus("Connected. Waiting for MCP commands.", COLORS.success)
            end

            task.wait(HEARTBEAT_INTERVAL)
        end
    end)

    -- Command polling worker
    task.spawn(function()
        local pollErrorShown = false

        while running and loopVersion == thisVersion do
            local response, err = httpRequest(
                "GET",
                "/next",
                nil,
                true
            )

            if response then
                if pollErrorShown then
                    pollErrorShown = false
                    setStatus(
                        "Connected. Waiting for MCP commands.",
                        COLORS.success
                    )
                end

                if response.command then
                    sendCommandResult(response.command)
                end
            elseif not pollErrorShown then
                pollErrorShown = true
                setStatus(
                    "Polling error; retrying: " .. shortText(err, 150),
                    COLORS.error
                )
            end

            task.wait(POLL_INTERVAL)
        end
    end)
end

testButton.Activated:Connect(function()
    local validatedUrl, urlError = validateBaseUrl(urlBox.Text)

    if not validatedUrl then
        setStatus(urlError, COLORS.error)
        return
    end

    baseUrl = validatedUrl

    local health, err = httpRequest(
        "GET",
        "/health",
        nil,
        false
    )

    if not health or health.ok ~= true then
        setStatus(
            "Server check failed: " .. shortText(err or "Unexpected response"),
            COLORS.error
        )
        return
    end

    if health.studioConnected then
        setStatus("Server reachable. Studio heartbeat is online.", COLORS.success)
    else
        setStatus("Server reachable. No recent Studio heartbeat.", COLORS.warning)
    end
end)

connectButton.Activated:Connect(function()
    if running then
        stopBridge()
    else
        startBridge()
    end
end)

toolbarButton.Click:Connect(function()
    widget.Enabled = not widget.Enabled
    toolbarButton:SetActive(widget.Enabled)
end)

widget:GetPropertyChangedSignal("Enabled"):Connect(function()
    toolbarButton:SetActive(widget.Enabled)
end)

widget:BindToClose(function()
    widget.Enabled = false
end)

plugin.Unloading:Connect(function()
    running = false
    loopVersion += 1
    activeToken = nil
end)

print("[AnyMCP] Plugin loaded. Open the AnyMCP toolbar panel to begin.")
