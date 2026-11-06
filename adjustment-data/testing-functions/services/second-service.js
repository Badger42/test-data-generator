import FirstService from './first-service'
import {countryCodes} from '../../common/values'

class SecondService {
  /**
   * @param {*} addresses addresses
   * @param {*} countryMap country map
   * @returns
   */
  hasCorrectAddress(addresses, countryMap) {
    const postals = [...new Set(addresses.map(x => x.postalCode))].sort()
    const blocks = []

    for (const postalCode of postals) {
      const address = FirstService.getAddressByCode(postalCode, countryMap)

      blocks.push(address)
    }

    return blocks.includes(countryCodes.Russia)
  }
}

export default new SecondService()
