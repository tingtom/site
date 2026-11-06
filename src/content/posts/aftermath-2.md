---
title: What is Aftermath? (2/2)
slug: what-is-aftermath-2
date: 2018-03-11
mins: 18
summary: What is Aftermath? Aftermath is a Source SDK mod created and started by me for learning the Source engine and for fun. The mod was inspired from the infamous "zombies" mode in Black Ops after having a lot of fun playing it with friends, the original idea was to fully replicate the mode as much as possible with sounds and models from the game.
sections: ["personal"]
---

With the mod being inspired from Call of Duty Zombies I had to change a lot of things that HL2 does, in the end the mod became more of a full conversion than the original concept of using the HL2 pistol against HL2 walking zombies.

The first thing I tested was how the zombies react and get to the player since the existing AI meant the zombies would get bored and walk away from the player, I also tested barricades a lot using brushes with a wood texture using the template entity but it wasn't working until I got better at coding and made my own baricade entity.

### Spawning Zombies

The monster_maker entity was the main source of figuring out how to create an endless amount of zombies, the monster_maker takes a template npc and a reference point for spawning the npcs and for some time was the way all the zombies in the mod were spawned (with some changes).

Some custom code was added to the monster_maker so that the health and damage of the zombie being spawned could be changed, health was already exposed in the SetHealth function so I could easily change the health based on the current round and other factors such as insta kill (which sets the health to 1).

The old template way of spawning zombies was later changed to use:

```cpp
CreateEntityByName( "npc_zombie" )
```

and was changed so only one entity had to be made (zs_zombiemaker) and up to 100 zs_spawnpoint entities could be made anywhere on the map and be toggled on and off individually which helped map makers make maps easier!

### Changing AI

The zombies still had some difficulty finding the player after being spawned so some changes had to be made to how the zombies found the player and in the future how they navigate the map. The changes to these functions in the ai_senses file overrides how zombies find the player so that they can always been found:

```cpp
bool CAI_Senses::Look( CBaseEntity *pSightEnt )
{
	CNPC_BaseZombie *pZombie = dynamic_cast<CNPC_BaseZombie*>( GetOuter() );
	if ( pZombie && pSightEnt->IsPlayer() && pSightEnt->m_lifeState == LIFE_ALIVE )
	{
		return SeeEntity( pSightEnt );
	}
	else
	{
		if ( WaitingUntilSeen( pSightEnt ) )
			return false;
	
		if ( ShouldSeeEntity( pSightEnt ) && CanSeeEntity( pSightEnt ) )
		{
			return SeeEntity( pSightEnt );
		}
		return false;
	}
}
```

In the above code, if the current NPC is a zombie and the entity being seen is a player and is alive the player is seen no matter what. This allows the zombie to find the player anywhere in the map.

```cpp
int CAI_Senses::LookForHighPriorityEntities( int iDistance )
{
	int nSeen = 0;
	if ( gpGlobals->curtime - m_TimeLastLookHighPriority > AI_HIGH_PRIORITY_SEARCH_TIME )
	{
		AI_PROFILE_SENSES(CAI_Senses_LookForHighPriorityEntities);
		m_TimeLastLookHighPriority = gpGlobals->curtime;
		
		BeginGather();
	
		float distSq = ( iDistance * iDistance );
		const Vector &origin = GetAbsOrigin();
		
		CNPC_BaseZombie *pZombie = dynamic_cast<CNPC_BaseZombie*>( GetOuter() );

		for ( int i = 1; i <= gpGlobals->maxClients; i++ )
		{
			CBaseEntity *pPlayer = UTIL_PlayerByIndex( i );

			if ( pPlayer )
			{
				if ( (origin.DistToSqr(pPlayer->GetAbsOrigin()) < distSq || pZombie) && Look( pPlayer ) )
				{
					nSeen++;
				}
			}
		}
	
		EndGather( nSeen, &m_SeenHighPriority );
    }
    else
    {
    	for ( int i = m_SeenHighPriority.Count() - 1; i >= 0; --i )
    	{
    		if ( m_SeenHighPriority[i].Get() == NULL )
    			m_SeenHighPriority.FastRemove( i );    			
    	}
    	nSeen = m_SeenHighPriority.Count();
    }
	
	return nSeen;
}
```

The above code overrides the distance check between the NPC and the player if the NPC is a zombie.

### Weapons

The final item for this blog post is the weapons, the weapon system needs to be stripped apart and put back together again. The HL2 weapon system didn't make sense for the mod so I had to get rid of slots and change how weapons where picked up and brought from walls. First I disabled the HUD elements for weapon selection which involved removing code in the **weapon_selection.cpp** and **weapons_resource.cpp** files and then began changing how weapons are picked up.

The original way a weapon is picked up in HL2 is using BumpWeapon which is called by the weapon itself when a player touches it at line 840 in the file basecombatweapon_shared.cpp, I override some things in the BumpWeapon function so only specific weapons can be picked up (most notably the starting pistol which is placed at the players feet in the level).

There's a second way that weapons can be picked up and that's the Use handler in the basecombatweapon.cpp file which is a fix so when weapons are "used" they can be equipped but I used this to equip the weapon instead:

```cpp
void CBaseCombatWeapon::Use( CBaseEntity *pActivator, CBaseEntity *pCaller, USE_TYPE useType, float value )
{
	CHL2MP_Player *pPlayer = ToHL2MPPlayer( pActivator );
	
	if ( pPlayer )
	{
		m_OnPlayerUse.FireOutput( pActivator, pCaller );

		if ( pPlayer->UseWeapon( this ) )
		{
			OnPickedUp( pPlayer );
		}
	}
}
```

The UseWeapon function handles points, messages and sounds for buying weapons:

```cpp
bool CHL2MP_Player::UseWeapon( CBaseCombatWeapon *pWeapon )
{
	// Don't let the player fetch weapons through walls (use MASK_SOLID so that you can't pickup through windows)
	if( !pWeapon->FVisible( this, MASK_SOLID ) && !(GetFlags() & FL_NOTARGET) )
	{
		return false;
	}

	bool bOwnsWeaponAlready = !!Weapon_OwnsThisType( pWeapon->GetClassname(), pWeapon->GetSubType());

	if ( bOwnsWeaponAlready == true ) 
	{
		//has enough points to get ammo
		if( points >= pWeapon->GetAmmoPointCost() )
		{
			 if ( Weapon_EquipAmmoOnly( pWeapon ) )
			 {
				 RemovePoints( pWeapon->GetAmmoPointCost() );
				 EmitSound( "Door.Buy" );

				 pWeapon->Respawn();
				 UTIL_Remove( pWeapon );
				 return true;
			 }
			 else
			 {
				 return false;
			 }
		}else{
			//error message
			hudtextparms_s tTextParam;
			tTextParam.x			= -1;
			tTextParam.y			= 0.60;
			tTextParam.effect		= 0;

			tTextParam.r1			= FlashlightIsOn() ? 153 : 255;//153
			tTextParam.g1			= FlashlightIsOn() ? 153 : 255;
			tTextParam.b1			= FlashlightIsOn() ? 153 : 255;
			tTextParam.a1			= 255;

			tTextParam.r2			= FlashlightIsOn() ? 153 : 255;
			tTextParam.g2			= FlashlightIsOn() ? 153 : 255;
			tTextParam.b2			= FlashlightIsOn() ? 153 : 255;
			tTextParam.a2			= 255;

			tTextParam.fadeinTime	= 0;
			tTextParam.fadeoutTime	= 0;

			tTextParam.holdTime		= 4;
			tTextParam.fxTime		= 0;
			tTextParam.channel		= 1;

			UTIL_HudMessage( this, tTextParam, "Not enough points" );

			return false;
		}
	}

	if ( points >= pWeapon->GetPointCost() )
	{
		RemovePoints( pWeapon->GetPointCost() );
		EmitSound( "Door.Buy" );

		pWeapon->Respawn();
		Weapon_Equip( pWeapon );

		return true;
	}else{
		//error message
		
		hudtextparms_s tTextParam;
		tTextParam.x			= -1;
		tTextParam.y			= 0.60;
		tTextParam.effect		= 0;

		tTextParam.r1			= FlashlightIsOn() ? 153 : 255;//153
		tTextParam.g1			= FlashlightIsOn() ? 153 : 255;
		tTextParam.b1			= FlashlightIsOn() ? 153 : 255;
		tTextParam.a1			= 255;

		tTextParam.r2			= FlashlightIsOn() ? 153 : 255;
		tTextParam.g2			= FlashlightIsOn() ? 153 : 255;
		tTextParam.b2			= FlashlightIsOn() ? 153 : 255;
		tTextParam.a2			= 255;

		tTextParam.fadeinTime	= 0;
		tTextParam.fadeoutTime	= 0;

		tTextParam.holdTime		= 4;
		tTextParam.fxTime		= 0;
		tTextParam.channel		= 1;

		UTIL_HudMessage( this, tTextParam, "Not enough points" );

		return false;
	}

	return false;
}
```

I suggest handling messages better, probably in a new nicely animated HUD element. There's some more features but I'll save these for a third blog post, one of the things I wanted to talk about was the navmesh implementation that was used to replace the node system as I kept running into limitations in hammer.
