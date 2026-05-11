# Utilisation des comptes de service

Ce document présente un exemple d'utilisation des comptes de service pour accéder à l'API en impersonnifiant un déclarant.

## Création du compte de service

```
node scripts/create-service-account.js "Service account de test"
```

Renvoie :

```
serviceAccountId: 95ef1e0a-f2f8-40e1-8555-29561f3615f6
```

## Association du compte de service à des déclarants

```
node -e '
import("dotenv/config");
import("./db/prisma.js").then(async ({prisma}) => {
  await prisma.$executeRaw`
    INSERT INTO "ServiceAccountDeclarant" (
      "id",
      "serviceAccountId",
      "declarantUserId",
      "startDate",
      "createdAt",
      "updatedAt"
    )
    SELECT
      gen_random_uuid(),
      ${"95ef1e0a-f2f8-40e1-8555-29561f3615f6"},
      d."userId",
      ${new Date("2026-01-01")},
      ${new Date()},
      ${new Date()}
    FROM "Declarant" d
    ON CONFLICT DO NOTHING
  `;
  await prisma.$disconnect();
})'
```


## Création des credentials associés au compte de service

```
node scripts/create-service-account-credential.js 95ef1e0a-f2f8-40e1-8555-29561f3615f6
```

Renvoie :

```
clientId: sa_e255e123-3298-4fe8-a45e-d3b428685b52
clientSecret: 09799106-fc9b-4d80-9039-fe0a2411ae99f58393ea30b83a1933ff8810610e8818d631b62a85acd2ab
```

## Création d'un token associé au service account

```
curl -X POST http://localhost:5000/service-accounts/token \
    -H "Content-Type: application/json" \
    -d '{
        "clientId": "sa_e255e123-3298-4fe8-a45e-d3b428685b52",
        "clientSecret": "09799106-fc9b-4d80-9039-fe0a2411ae99f58393ea30b83a1933ff8810610e8818d631b62a85acd2ab"
    }' | jq -r '.accessToken' 
```

Renvoie :

```
a202836c-f2c7-4043-b8eb-670716bb1dbb016b7a99bec40dd17540e0f0e582a1dc65248132632b9ba1
```

## Utilisation du token pour récupérer les déclarants associés au compte de service

```
curl -X GET http://localhost:5000/service-accounts/me/declarants \
    -H "Authorization: Bearer a202836c-f2c7-4043-b8eb-670716bb1dbb016b7a99bec40dd17540e0f0e582a1dc65248132632b9ba1"
    | jq -r '.data[0].declarantUserId'
```

Renvoie :

```
00230bb0-3b2c-48ba-b20a-645edbedbd3d
```

## Récupération du contexte du déclarant

```
curl -X GET http://localhost:5000/service-accounts/declarants/00230bb0-3b2c-48ba-b20a-645edbedbd3d/context \
    -H "Authorization: Bearer a202836c-f2c7-4043-b8eb-670716bb1dbb016b7a99bec40dd17540e0f0e582a1dc65248132632b9ba1" \
    | jq .
```

Renvoie :

```
{
  "success": true,
  "exploitations": [
    // [...]
    {
      "point": {
        "id": "392e70c3-f3ba-456a-952e-697a28f7da9d",
        "name": "26-1112"
      },
      "mostRecentAvailableDate": "2026-04-15T00:00:00.000Z",
      "connectors": [
        {
          "id": "f1b4bd53-66fd-49fb-bb03-1f7662602f96",
          "type": "orange_live_objects",
          "rate": 70,
          "parameters": {
            "sourcePointId": "urn:lo:nsid:imei:359404232383910"
          }
        }
      ],
      "connector": {
        "id": "f1b4bd53-66fd-49fb-bb03-1f7662602f96",
        "type": "orange_live_objects",
        "rate": 70,
        "parameters": {
          "sourcePointId": "urn:lo:nsid:imei:359404232383910"
        }
      }
    }
  ]
}

```

## Génération d'un token JWT pour ce déclarant

```
curl -X POST http://localhost:5000/service-accounts/declarants/00230bb0-3b2c-48ba-b20a-645edbedbd3d/token \
    -H "Authorization: Bearer a202836c-f2c7-4043-b8eb-670716bb1dbb016b7a99bec40dd17540e0f0e582a1dc65248132632b9ba1" \
    | jq -r '.accessToken'
```

Renvoie :

```
827e03d5-24cd-4545-a6b5-e43f1a1ff88fcfd7683bc16f53566cc23615c3a560d401cd58595dc21ee0
```

## Utilisation du token JWT d'impersonnification pour pousser une déclaration

TODO

## Ingestion d'un connecteur API

Le payload d'ingestion doit continuer à fournir `metadata.point_id`,
`metadata.declarant_id` et `metadata.context_id`. Quand le contexte déclarant
expose plusieurs connecteurs pouvant correspondre au même point, l'orchestrateur
doit aussi transmettre `metadata.connector_id`.

L'API applique le `rate` stocké sur le connecteur autorisé avant de créer les
valeurs de prélèvement. Par exemple, avec un `rate` de `70`, une valeur entrante
de `100 m³` sera importée comme `70 m³`.
