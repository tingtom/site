---
title: Weapon script reloading in Source SDK
slug: weapon-script-reload
date: 2019-12-13
mins: 5
summary: In Source SDK you have to restart after editing a weapon script, this code will let you use a console command to reload the script of the current weapon after editing it
sections: ["personal"]
---

In Source SDK you have to restart after editing a weapon script, this can be a pain when messing around with ammo or custom features you've added. I'm not 100% sure if everything works after reloading the script but it sure helps.

First of all we're going to add a function called ReloadScheme to the basecombatweapon class so in basecombatweapon_shared.h add this in the public section:

```cpp
virtual void ReloadScheme()
{
    ReadWeaponDataFromFileForSlot(filesystem, GetClassname(), &m_hWeaponFileInfo, GetEncryptionKey(), true);
}
```
also make sure this is at the top:

```cpp
#include "weapon_parse.h"
```

in weapon_parse.h add a reset boolean to ReadWeaponDataFromFileForSlot like so:

```cpp
// The weapon parse function
bool ReadWeaponDataFromFileForSlot( IFileSystem* filesystem, const char *szWeaponName, 
	WEAPON_FILE_INFO_HANDLE *phandle, const unsigned char *pICEKey = NULL, bool reset = false );
```

then in the code for the function in weapon_parse.cpp add a check for the reset boolean:

```cpp
if (reset)
{
    unsigned short lookup = m_WeaponInfoDatabase.Find(szWeaponName);
    if (lookup != m_WeaponInfoDatabase.InvalidIndex())
    {
        delete m_WeaponInfoDatabase[lookup];
        m_WeaponInfoDatabase.RemoveAt(lookup);
    }
}
```

under the return false at the top of the function. Then to wrap it all together add the console command to the top of the basecombatweapon_shared.cpp file within `#if !defined( CLIENT_DLL )`

```cpp
void CC_ReloadScript(void)
{
    CBasePlayer* pPlayer = UTIL_GetCommandClient();
    if (pPlayer == NULL)
        return;

    CBaseCombatWeapon *pWeapon = pPlayer->GetActiveWeapon();
    if (pWeapon == NULL)
        return;

    pWeapon->ReloadScheme();
}

static ConCommand weapon_reloadscript("weapon_reloadscript", CC_ReloadScript);
```
