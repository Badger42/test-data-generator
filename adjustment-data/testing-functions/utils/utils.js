import {specificPTypes, pTypes} from '../../common/values'

export function sumCurrency(...args) {
  return args.reduce((prev, current) => {
    Object.entries(current)
      .map(([currency, val]) => ({currency, val}))
      .forEach(prop => {
        prev[prop.currency] = (prev[prop.currency] || 0) + prop.val
      })
    return prev
  }, {})
}

export function getSomeTypeCount(obj) {
  const countingTypes = specificPTypes.reduce((a, p) => {
    const foundType = pTypes[p]
    return a + (obj[foundType] || 0)
  }, 0)
  return countingTypes
}

export function plusSymbol(phone) {
  if (phone == null) return ''

  phone = phone.replace(/[^\d]/g, '')
  if (phone.match(/^(8)[\d]{10}$/)) {
    return ''
  }
  return '+'
}

export function hasCyrillicLetters(value) {
  return value ? /[А-Яа-яЁё]/.test(value) : false
}

