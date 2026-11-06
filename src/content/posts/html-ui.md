---
title: HTML UI in Source SDK
slug: html-ui-in-source
date: 2018-12-23
mins: 7
summary: I always think I've reached the limits of the Source engine but I think I'm just not giving the engine enough credit, for Resurgence we keep messing around with the UI and one day I had an idea for using the HTML control for it which will allow it to be prototyped faster and allow non-programmers to provide a proper representation instead of an image.
sections: ["personal"]
---

I always think I've reached the limits of the Source engine but I think I'm just not giving the engine enough credit, for Resurgence we keep messing around with the UI and one day I had an idea for using the HTML control for it which will allow it to be prototyped faster and allow non-programmers to provide a proper representation instead of an image.

I had heard of awesomium but that's a bit messy and seems to be dead so I started with the HTML VGUI control which creates a CEF off-screen renderer for rendering and renders the result onto a VGUI panel, this was great as a starting point until I noticed a major issue when overriding the main menu VGUI element.

### Transparency

Resurgence has a cool main menu background map and for some reason Valve decided they didn't need transparency when rendering the HTML control, I poked around a bit and came to the conclusion that pretty much everything was in the chromehtml DLL and although the source is available I wasn't able to get it built with a old version of CEF.

I didn't give up and instead had an idea to use a chroma key and set the background to green, this kinda worked but created issues for text and any transparency that we decided to use for the menu. I kept looking for a solution and while checking out the [Source SDK Github]("https://github.com/ValveSoftware/source-sdk-2013") I noticed that the HTML control was slightly different to my version which was weird because Valve have pretty much abandoned it.. I compared the two and basically the off-screen renderer is now handled by the Steam client using the API so I copied over the required files for the HTML control and new Steam API code (which also requires new steam_api and steamvr DLLs) and the off-screen renderer was using a transparent background!

### Navigation

Now that the rendering was working and a HTML file was being loaded I began coding the menu flow and trying to figure out how the user will navigate around the menu. I didn't want a natural website with static HTML files because I wasn't sure how opening a bunch of HTML files would look or how fluid it would be so I poked around Javascript libraries and decided to use Vue and it's Router for navigation.

The Vue router uses hashes to pretend to be a URL, hashes are normally used for anchors to scroll a user to a specific point but with Javascript you can dynamically set, read and react to hash changes so you can navigate to #/play and Vue will swap an entire section from the default component to another component setup when initialising Vue router with a transition.

### Data

Now that I had some kind of structure for the new menu I needed to get game data over to Vue and bind it for buttons, text and images. Communication from C++ to the off-screen renderer is very limited compared to if you setup CEF yourself but there's one function called "ExecuteJavascript" which does exactly what it says and allows you to send JS code.

The best way would be to use a JSON library to create a structure and send it over once the HTML file has loaded to init Vue, the only issue is Source is pretty old and doesn't have a JSON library so after trying 3-4 different libs I ended up using [RapidJSON]("http://rapidjson.org/") since most newer libs use features that the 2010 built tools don't support.

The structure contained the different paths and content within the paths, each button either had a URL to another route or had a custom protocol (res://) that did something specific like loading a map or opening a Steam overlay URL which the mod would handle:

```cpp
const char* url = data->GetString("url");

CUtlVector<char*, CUtlMemory<char*, int>> strs;
V_SplitString(url, "/", strs);
strs.Remove(0);//remove "res:"

if (strs.Count() >= 0)
{
	if (strcmp(strs[0], "menu") == 0)
	{
		char str[100];
		Q_strncpy(str, "gamemenucommand ", sizeof(str));
		Q_strncat(str, strs[1], sizeof(str), COPY_ALL_CHARACTERS);

		engine->ClientCmd(str);
	}
	else if (strcmp(strs[0], "command") == 0)
	{
		engine->ClientCmd(strs[1]);
	}
	else if (strcmp(strs[0], "play") == 0)
	{
		g_pCVar->RevertFlaggedConVars(FCVAR_REPLICATED);
		g_pCVar->RevertFlaggedConVars(FCVAR_CHEAT);

		char szMapCommand[1024];
		Q_snprintf(szMapCommand, sizeof(szMapCommand), "disconnect\nwait\nwait\nsv_lan 0\nsetmaster enable\nmaxplayers 1\nhostname \"Game Name\"\nprogress_enable\nmap %s\n", strs[1]);

		// exec
		engine->ClientCmd_Unrestricted(szMapCommand);
	}
	else if (strcmp(strs[0], "achievements") == 0)
		steamapicontext->SteamFriends()->ActivateGameOverlay("Achievements");
}
```

### In-game state

The menu is also used in game and since the UI is now custom the menu it looks exactly the same and needs to be reset when entering a level so I had to check for the engine->IsInGame() flag to see if it has changed and reset the HTML control and tell Vue to render some components differently, I ended up using the new map game event and navigating the page to root using the router like so:

```cpp
void FireGameEvent(IGameEvent *event)
{
	if (strcmp(event->GetName(), "game_newmap") != 0)
		return;

        ...

	html->RunJavascript("navigateTo('/')");

        ...
}
```

As well as navigating back to home, the internal JS game data object is updated with an inGame flag so features such as changing the main menu can be achieved.

### Final points

I've been slowly expanding the menu out to have difficulty selection, collectibles, loadout and want to move achievements to it. I also recently swapped to using webpack to compile all the vue components into 1-2 js files which is easier to deal with. Here's a video showing a bit of it:

<iframe style="display: block; margin-left: auto; margin-right: auto;max-width:560px" src="https://www.youtube.com/embed/eyWjmHOO4ko" allowfullscreen="allowfullscreen" width="100%" height="315" frameborder="0"></iframe>
