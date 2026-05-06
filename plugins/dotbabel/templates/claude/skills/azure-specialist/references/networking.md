# Azure Networking

## Key Concepts

- **VNet** — isolated virtual network. Address space + subnets. Peering (same region cheap, global region peering +$).
- **VWAN** — hub-and-spoke backbone for enterprises spanning multiple regions and on-prem.
- **NSG** — stateful firewall at subnet or NIC level. Default rules allow VNet ↔ VNet and deny inbound Internet.
- **App Gateway** — L7 load balancer with WAF. Path-based routing + SSL offload + health probes.
- **Front Door** — global edge network. Standard (simple CDN + routing) vs Premium (WAF, Private Link to origin).
- **Private Endpoint** — private IP for Azure PaaS services (Storage, Cosmos, Key Vault), binding them into your VNet.
- **Service Endpoint** — older model granting subnet-level access to PaaS services (not per-IP).

## Common Patterns

```bicep
// VNet with multi-subnet + NSG
resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: 'app-vnet'
  properties: {
    addressSpace: { addressPrefixes: ['10.0.0.0/16'] }
    subnets: [
      { name: 'app'; properties: { addressPrefix: '10.0.1.0/24'; networkSecurityGroup: { id: nsg.id } } }
      { name: 'db';  properties: { addressPrefix: '10.0.2.0/24'; serviceEndpoints: [{ service: 'Microsoft.Sql' }] } }
      { name: 'pe';  properties: { addressPrefix: '10.0.3.0/24'; privateEndpointNetworkPolicies: 'Disabled' } }
    ]
  }
}
```

```bicep
// App Gateway with WAF v2 + path-based rules
resource agw 'Microsoft.Network/applicationGateways@2024-01-01' = {
  name: 'app-agw'
  properties: {
    sku: { name: 'WAF_v2'; tier: 'WAF_v2' }
    webApplicationFirewallConfiguration: {
      enabled: true
      firewallMode: 'Prevention'
      ruleSetType: 'OWASP'
      ruleSetVersion: '3.2'
    }
    ...
  }
}
```

## Checklist

- [ ] NSGs default-deny inbound from Internet; explicit allows only for required ports.
- [ ] Subnets have NSGs attached (subnet NSG vs NIC NSG — subnet is preferred).
- [ ] App Gateway / Front Door WAF in Prevention (not Detection) for production.
- [ ] Private Endpoints used for PaaS access; Public Network Access disabled on Storage/Cosmos/Key Vault.
- [ ] VNet peering — ensure `allowGatewayTransit` and `useRemoteGateways` set correctly for hub-spoke.
- [ ] DDoS Standard Protection enabled on production-critical VNets (Basic is always on and free).

## Gotchas

- NSG effective rules are evaluated from lowest priority number up — lower number = higher priority. Off-by-one priority breaks intended order.
- VNet peering is non-transitive. A↔B and B↔C doesn't connect A↔C. Route via hub (App Gateway, Firewall) or VWAN.
- Private Endpoint DNS requires Private DNS Zone linked to the VNet — missing this silently resolves to public IP.
- App Gateway backend health probes fail silently when the backend's HTTP Host header doesn't match the probe's configured host.
- Front Door Standard can't route to private origins; Premium adds Private Link support.
- Service Endpoints allow the subnet's origin IP to be public-facing when resolving to the service — Private Endpoints mask traffic fully within VNet.
