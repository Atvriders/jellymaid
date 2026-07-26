// tests/auth/address.test.ts
import { describe, it, expect } from 'vitest'
import { isPrivateAddress } from '../../src/auth/address.js'

describe('isPrivateAddress', () => {
  const cases: Array<[string | undefined, boolean, string]> = [
    ['127.0.0.1', true, 'loopback IPv4'],
    ['127.255.255.255', true, 'loopback IPv4, high end of /8'],
    ['::1', true, 'loopback IPv6'],
    ['10.0.0.1', true, '10.0.0.0/8'],
    ['10.255.255.255', true, '10.0.0.0/8, high end'],
    ['172.16.0.1', true, '172.16.0.0/12, low end'],
    ['172.31.255.255', true, '172.16.0.0/12, high end'],
    ['172.15.255.255', false, 'just below 172.16.0.0/12'],
    ['172.32.0.0', false, 'just above 172.16.0.0/12'],
    ['192.168.0.1', true, '192.168.0.0/16, low end'],
    ['192.168.255.255', true, '192.168.0.0/16, high end'],
    ['192.169.0.1', false, 'just above 192.168.0.0/16'],
    ['169.254.1.1', true, '169.254.0.0/16 link-local'],
    ['169.253.255.255', false, 'just below 169.254.0.0/16'],
    ['fc00::1', true, 'fc00::/7, low end'],
    ['fd12:3456:789a::1', true, 'fc00::/7, fd sub-range'],
    ['fdff:ffff::1', true, 'fc00::/7, high end'],
    ['fe00::1', false, 'just above fc00::/7'],
    ['fbff::1', false, 'just below fc00::/7'],
    ['::ffff:10.0.0.1', true, 'IPv4-mapped private address'],
    ['::ffff:9.9.9.9', false, 'IPv4-mapped public address'],
    ['', true, 'empty string treated as private (skip)'],
    [undefined, true, 'undefined treated as private (skip)'],
    ['9.9.9.9', false, 'public IPv4'],
    ['1.1.1.1', false, 'public IPv4'],
    ['2606:4700::1111', false, 'public IPv6'],
  ]

  it.each(cases)('isPrivateAddress(%j) === %j (%s)', (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected)
  })
})
