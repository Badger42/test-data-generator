import {
  eastCountryCodes,
} from '../../common/values'
import isEmpty from 'lodash/isEmpty'

export default {
  hasEmptyContacts(employee) {
    return isEmpty(employee.email) || isEmpty(employee.phone)
  },
  getAddressByCode: function(cityCode, citiesList) {
    return citiesList.find(city => city.postalCode === cityCode)?.country
  },
  hasCorrectAddress(addresses, allCyties) {
    return addresses?.some(address => {
      const departureAddress = this.getAddressByCode(address.departure, allCyties)
      const arrivalAddress = this.getAddressByCode(address.arrival, allCyties)
      return (
        departureAddress !== arrivalAddress &&
        (eastCountryCodes.includes(departureAddress) || eastCountryCodes.includes(arrivalAddress))
      )
    })
  },
}
