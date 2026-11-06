---
title: Showing Legs in Source SDK
slug: legs-in-source
date: 2019-08-05
mins: 4
summary: An interesting addition to Aftermath was to show the legs of the player, each player could look down at their own player model which allowed each player to have a kind of representation in the game as they can see themselves and know which character they are
sections: ["personal"]
---

An interesting addition to Aftermath was to show the legs of the player, each player could look down at their own player model which allowed each player to have a kind of representation in the game as they can see themselves and know which character they are.

This post will be for singleplayer as this is the latest example I have but multiplayer should be similar since it's only client side code. All the code is in c_baseplayer.cpp & h, first you make sure the model is set for the player:

```cpp
void C_BasePlayer::Spawn( void )
{
	SetModel( "models/myplayermodel/playermodel.mdl" );
}
```

This is because the legs come from the player model and the default has no animations and will not look great, next we'll move the model back so the camera doesn't clip with the camera.

```cpp
const Vector& C_BasePlayer::GetRenderOrigin( void )
{
	//Dont apply in thirdperson
	if( IsLocalPlayer() && !input->CAM_IsThirdPerson() )
	{
		static Vector forward;
		AngleVectors( GetRenderAngles(), &forward );

		// Shift the render origin by a fixed amount
		forward *= -25;
		forward += GetAbsOrigin();

		return forward;
	}else{
		return BaseClass::GetRenderOrigin();
	}
}
```

Here we determine the forward position (if we're not in thirdperson) and use it to change the render origin of the model back a bit, you can change 25 to whatever you want or even use a convar and test it in game.

```cpp
ConVar cl_legs( "cl_legs", "1", 0, "Enable or disable player leg rendering", true, 0, true, 1 );

int C_BasePlayer::DrawModel( int flags )
{
	//Ignore if the convar is enabled
	if( !cl_legs.GetBool() )
		return 0;

	CMatRenderContextPtr context(materials);

	//Don't render above a certain height of the body
	if ( IsLocalPlayer() && !input->CAM_IsThirdPerson() )
	{
		if ( (GetFlags() & FL_DUCKING) || m_Local.m_bDucking )
		{
			context->SetHeightClipMode(MATERIAL_HEIGHTCLIPMODE_RENDER_BELOW_HEIGHT);
			context->SetHeightClipZ(GetAbsOrigin().z+27);
		}else{
			context->SetHeightClipMode(MATERIAL_HEIGHTCLIPMODE_RENDER_BELOW_HEIGHT);
			context->SetHeightClipZ(GetAbsOrigin().z+50);
		}
	}

	//Draw the model
	int nDrawRes = BaseClass::DrawModel(flags);

	// Remove height clipping
	context->SetHeightClipMode(MATERIAL_HEIGHTCLIPMODE_DISABLE);

	return nDrawRes;
}
```

Here we clip the player model to remove the upperbody and even lower if the player is ducking, there's also a convar for disabling the legs.

That's pretty much it, if you have access to the player models another option is to create a bodygroup and disable several parts of the body as you see fit but this is the easiest option.
